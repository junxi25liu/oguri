/**
 * A result the task never heard must be kept and published later, once.
 *
 * Before this, a run whose report and fallback report were both refused was
 * recorded `unreported` and never looked at again, leaving its task
 * `in_progress` under the worker for good.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { Backend } from "@oguri/daemon";

import { fakeBackend, policy, result, ME, type FakeTask } from "./fake-backend.ts";
import { REPORT_RETRY_MAX_MS, reportDelayMs, reportStuck } from "../src/report.ts";
import { listRuns, runDir, writeRunRecord } from "../src/runs.ts";
import { Worker } from "../src/worker.ts";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-report-retry-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * A backend whose final reports can be refused. A successful `taskUpdate`
 * becomes a task event, as on the real log; `reachThenFail` lets the update
 * land and still throws, the case a timeout after a successful push produces.
 */
function setup(options: { task?: Partial<FakeTask> } = {}) {
  const task: FakeTask = {
    id: ID,
    state: "open",
    creator: "alice-claude",
    definition: "Fix it.",
    events: [],
    ...options.task,
  };
  const fake = fakeBackend([task]);
  const control = { failing: true, reachThenFail: false };
  let landed = false;
  const backend: Backend = {
    ...fake.backend,
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === "taskUpdate") {
        const input = params["input"] as { action: string; body: string };
        const final = input.action !== "started" && input.action !== "progressed";
        if (final && control.failing && (!control.reachThenFail || landed)) {
          throw new Error("push refused");
        }
        const out = await fake.backend.call<T>(method, params);
        task.events = [
          ...(task.events ?? []),
          { action: input.action, body: input.body, from: ME },
        ];
        if (final && control.failing) {
          landed = true;
          throw new Error("timed out after the push");
        }
        return out;
      }
      return await fake.backend.call<T>(method, params);
    },
  };
  return { task, fake, control, backend };
}

function worker(backend: Backend, clock: { now: number }): Worker {
  return new Worker({
    backend,
    agentId: ME,
    home,
    loadPolicy: async () => policy(),
    now: () => clock.now,
    executor: async () => result(),
  });
}

function finals(fake: ReturnType<typeof fakeBackend>): string[] {
  return fake
    .updates()
    .map((u) => u.action)
    .filter((a) => a !== "started" && a !== "progressed");
}

describe("a report the task did not receive", () => {
  it("is kept as pendingReport, then published exactly once on a later pass", async () => {
    const clock = { now: T0 };
    const { task, fake, control, backend } = setup();
    const w = worker(backend, clock);

    await w.pass();
    await w.idle();
    task.hidden = true;

    const [held] = await listRuns(home);
    assert.equal(held?.outcome, "unreported");
    assert.equal(held?.pendingReport?.action, "completed");
    assert.equal(held?.pendingReport?.attempts, 1);
    assert.equal(held?.pendingReport?.nextAt, new Date(T0 + 30_000).toISOString());
    assert.match(held?.pendingReport?.body ?? "", /Done by worker/);
    assert.deepEqual(finals(fake), [], "nothing reached the task");

    // Not due yet: the pass leaves it alone.
    control.failing = false;
    clock.now = T0 + 10_000;
    const early = await w.pass();
    assert.equal(early.reported, undefined);
    assert.deepEqual(finals(fake), []);

    clock.now = T0 + 31_000;
    const due = await w.pass();
    assert.deepEqual(
      due.reported?.map((r) => [r.taskId, r.result, r.outcome]),
      [[ID, "published", "completed"]],
    );
    assert.deepEqual(finals(fake), ["completed"]);
    const [settled] = await listRuns(home);
    assert.equal(settled?.outcome, "completed");
    assert.equal(settled?.pendingReport, undefined);

    // Converged: another pass publishes nothing more.
    clock.now = T0 + 10 * 60_000;
    await w.pass();
    assert.deepEqual(finals(fake), ["completed"]);
  });

  it("backs off 30s, 60s, 120s and flags the record after three failures", async () => {
    const clock = { now: T0 };
    const { task, backend } = setup();
    const w = worker(backend, clock);
    await w.pass();
    await w.idle();
    task.hidden = true;

    const delays: number[] = [];
    for (let i = 0; i < 2; i++) {
      const [before] = await listRuns(home);
      assert.ok(before?.pendingReport);
      assert.equal(reportStuck(before), false);
      clock.now = Date.parse(before.pendingReport.nextAt) + 1;
      const at = clock.now;
      await w.pass();
      const [after] = await listRuns(home);
      delays.push(Date.parse(after?.pendingReport?.nextAt ?? "") - at);
    }
    assert.deepEqual(delays, [60_000, 120_000]);
    const [stuck] = await listRuns(home);
    assert.equal(stuck?.pendingReport?.attempts, 3);
    assert.equal(reportStuck(stuck as NonNullable<typeof stuck>), true);
    assert.equal(stuck?.outcome, "unreported", "still retrying, not abandoned");

    assert.equal(reportDelayMs(1), 30_000);
    assert.equal(reportDelayMs(20), REPORT_RETRY_MAX_MS);
  });

  it("is published after a restart by a new worker process", async () => {
    const clock = { now: T0 };
    const first = setup();
    const w1 = worker(first.backend, clock);
    await w1.pass();
    await w1.idle();
    first.task.hidden = true;
    assert.equal((await listRuns(home))[0]?.outcome, "unreported");

    // A new Worker has no memory of the first one; only run.json carries over.
    first.control.failing = false;
    clock.now = T0 + 60_000;
    const w2 = worker(first.backend, clock);
    await w2.pass();

    assert.deepEqual(finals(first.fake), ["completed"]);
    assert.equal((await listRuns(home))[0]?.outcome, "completed");
  });

  it("is settled without a second publication when it already reached the task", async () => {
    const clock = { now: T0 };
    const { task, fake, control, backend } = setup();
    control.reachThenFail = true;
    const w = worker(backend, clock);
    await w.pass();
    await w.idle();
    task.hidden = true;

    assert.equal((await listRuns(home))[0]?.outcome, "unreported");
    assert.deepEqual(finals(fake), ["completed"], "the first attempt did land");

    control.failing = false;
    clock.now = T0 + 31_000;
    await w.pass();

    assert.deepEqual(finals(fake), ["completed"], "the retry found its own report and added none");
    assert.equal((await listRuns(home))[0]?.outcome, "completed");
  });

  it("is only settled, never published, when the task was cancelled meanwhile", async () => {
    const clock = { now: T0 };
    const { task, fake, control, backend } = setup();
    const w = worker(backend, clock);
    await w.pass();
    await w.idle();
    task.hidden = true;

    task.state = "cancelled";
    control.failing = false;
    clock.now = T0 + 31_000;
    const due = await w.pass();

    assert.deepEqual(
      due.reported?.map((r) => r.result),
      ["settled"],
    );
    assert.deepEqual(finals(fake), []);
    const [record] = await listRuns(home);
    assert.equal(record?.outcome, "cancelled");
    assert.equal(record?.pendingReport, undefined);
    assert.match(record?.note ?? "", /not published/);
  });

  it("handles an unreported record written before pendingReport existed", async () => {
    const clock = { now: T0 };
    const { task, fake, control, backend } = setup();
    control.failing = false;
    task.hidden = true;
    const runId = "01JBBBBBBBBBBBBBBBBBBBBBBB";
    await writeRunRecord(home, {
      taskId: ID,
      runId,
      room: "ops",
      title: "old",
      runner: "claude",
      startedAt: new Date(T0 - 3_600_000).toISOString(),
      finishedAt: new Date(T0 - 3_000_000).toISOString(),
      exitCode: 0,
      outcome: "unreported",
      note: "push refused",
    });

    const w = worker(backend, clock);
    const report = await w.pass();

    assert.deepEqual(
      report.reported?.map((r) => r.result),
      ["published"],
    );
    const published = fake.updates().filter((u) => u.action === "blocked");
    assert.equal(published.length, 1, "a legacy record is reported, not ignored");
    assert.ok(
      published[0]?.body.includes(`${ME}:${runDir(home, ID, runId)}`),
      "the report names the run's log directory",
    );
    assert.equal((await listRuns(home))[0]?.outcome, "blocked");

    // And it does not repeat.
    clock.now = T0 + 3_600_000;
    await w.pass();
    assert.equal(fake.updates().filter((u) => u.action === "blocked").length, 1);
  });

  it("leaves a run that is still in flight alone", async () => {
    const clock = { now: T0 };
    const { task, backend } = setup();
    task.hidden = true;
    await writeRunRecord(home, {
      taskId: ID,
      runId: "01JBBBBBBBBBBBBBBBBBBBBBBB",
      room: "ops",
      title: "x",
      runner: "claude",
      startedAt: new Date(T0).toISOString(),
      outcome: "running",
      workerPid: process.pid,
    });
    const w = worker(backend, clock);
    const report = await w.pass();
    assert.equal(report.reported, undefined);
  });
});
