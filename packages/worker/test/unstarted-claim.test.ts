/**
 * A claim whose run never wrote a record must not strand the task.
 *
 * The worker claims, then starts a run. The run's first act is to write its
 * `run.json`, and before that write succeeds there is no local record of the
 * claim at all — so every recovery path (which reads records) is blind to it,
 * and the task stays `claimed` under this agent forever while every surface
 * reports it in flight. The audit reproduced exactly this by making `<home>/runs`
 * a plain file: `mkdir` fails with ENOTDIR, the run crashes before its record,
 * and restarting — even after the directory is repaired — never settles the task.
 *
 * The fix settles the claim the same way an abandoned run is settled: through
 * `abandonAction`, so `worker.onAbandon` still decides release versus block,
 * and a release still takes the usual backoff before this machine retries.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { WorkerPolicy } from "@oguri/core";

import { fakeBackend, policy as basePolicy } from "./fake-backend.ts";
import { listRuns } from "../src/runs.ts";
import type { Executor } from "../src/runner.ts";
import { Worker } from "../src/worker.ts";

const ME = "bob-claude";
const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";

function policy(overrides: Partial<WorkerPolicy> = {}): WorkerPolicy {
  return { ...basePolicy(overrides), enabled: true };
}

/** A runner that must never be executed: the run dies before it can start. */
const neverRuns: Executor = async () => {
  throw new Error("the executor must not start when the run record cannot be written");
};

async function waitForIdle(worker: Worker, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (worker.running > 0) {
    if (Date.now() > deadline) throw new Error("the run never settled");
    await sleep(10);
  }
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-unstarted-claim-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Make every run-record write fail, the way a broken `runs` path does. */
async function breakRunsDir(): Promise<void> {
  await writeFile(join(home, "runs"), "this is not a directory\n");
}

describe("a claim whose run record could not be written", () => {
  it("releases the task instead of leaving it claimed, with no run and no report", async () => {
    await breakRunsDir();
    const { backend, updates, calls } = fakeBackend([
      { id: ID_A, state: "open", creator: "alice-claude", definition: "Fix it." },
    ]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
      executor: neverRuns,
    });

    const report = await worker.pass();
    await waitForIdle(worker);
    await worker.idle();

    // The claim happened first; this test is about what happens after it.
    assert.ok(
      calls.some((c) => c.method === "taskClaim"),
      "the worker claimed the task before the run failed",
    );
    assert.ok(
      !calls.some(
        (c) =>
          c.method === "taskUpdate" &&
          (c.params["input"] as { action?: string }).action === "started",
      ),
      "no `started` was ever published for a run that did not start",
    );
    assert.deepEqual(
      updates().map((u) => [u.taskId, u.action]),
      [[ID_A, "released"]],
      "the claim is handed back rather than stranded",
    );
    assert.match(updates()[0]?.body ?? "", /could not start|released/i);
    assert.deepEqual(report.started, [ID_A]);
  });

  it("blocks instead of releasing when worker.onAbandon is block", async () => {
    await breakRunsDir();
    const { backend, updates } = fakeBackend([
      { id: ID_A, state: "open", creator: "alice-claude", definition: "Fix it." },
    ]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ onAbandon: "block" }),
      executor: neverRuns,
    });

    await worker.pass();
    await waitForIdle(worker);

    assert.deepEqual(
      updates().map((u) => u.action),
      ["blocked"],
      "the same policy that decides an abandoned run decides this one",
    );
  });

  it("does not hand the task straight back to the machine that just failed it", async () => {
    await breakRunsDir();
    const { backend, updates } = fakeBackend([
      { id: ID_A, state: "open", creator: "alice-claude", definition: "Fix it." },
    ]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ retry: { backoffMinutes: 10 } }),
      executor: neverRuns,
    });

    await worker.pass();
    await waitForIdle(worker);
    const first = updates().length;
    await worker.pass();
    await waitForIdle(worker);

    assert.equal(
      updates().length,
      first,
      "the second pass is backed off, so the failure cannot turn into a retry loop",
    );
  });

  it("still settles a claim when the runs directory has been repaired", async () => {
    await breakRunsDir();
    const { backend, updates } = fakeBackend([
      { id: ID_A, state: "open", creator: "alice-claude", definition: "Fix it." },
    ]);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
      executor: neverRuns,
    });

    await worker.pass();
    await waitForIdle(worker);

    // A later, healthy pass over a fresh task must not be affected by the
    // broken one, and nothing stays listed as running.
    await rm(join(home, "runs"), { force: true });
    const again = fakeBackend([
      { id: ID_B, state: "open", creator: "alice-claude", definition: "Fix it." },
    ]);
    const healthy = new Worker({
      backend: again.backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
      executor: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        stdoutTail: "done",
      }),
    });
    await healthy.pass();
    await healthy.idle();

    assert.deepEqual(
      again.updates().map((u) => u.action),
      ["started", "completed"],
      "the repaired machine runs new work normally",
    );
    assert.deepEqual(
      (await listRuns(home)).map((r) => r.taskId),
      [ID_B],
      "no record exists for the run that never started",
    );
    assert.deepEqual(
      updates().map((u) => u.action),
      ["released"],
      "the stranded claim was settled, not left behind",
    );
  });
});
