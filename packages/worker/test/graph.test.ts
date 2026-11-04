import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { failureAction, RetryBackoff } from "../src/retry.ts";
import { listRuns } from "../src/runs.ts";
import { selectCandidates } from "../src/select.ts";
import { Worker } from "../src/worker.ts";
import { ME, coded, fakeBackend, policy, result, type FakeTask } from "./fake-backend.ts";

const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const ID_C = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const ID_D = "01JDDDDDDDDDDDDDDDDDDDDDDD";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-worker-graph-"));
});

function worker(
  backend: ReturnType<typeof fakeBackend>["backend"],
  options: {
    policy?: Parameters<typeof policy>[0];
    executor?: ConstructorParameters<typeof Worker>[0]["executor"];
    now?: () => number;
    log?: string[];
  } = {},
): Worker {
  return new Worker({
    backend,
    agentId: ME,
    machineId: "build-01",
    home,
    loadPolicy: async () => policy({ workdir: home, ...options.policy }),
    executor: options.executor ?? (async () => result()),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: (line) => options.log?.push(line) }),
  });
}

describe("task graph pickup", () => {
  it("claims only ready entries, and says once why the others wait", async () => {
    const tasks: FakeTask[] = [
      { id: ID_A },
      { id: ID_B, ready: false, waitingOn: [{ id: ID_A, state: "open" }] },
      { id: ID_C, ready: false, attempt: 2, maxAttempts: 2 },
    ];
    const { backend, calls } = fakeBackend(tasks);
    const log: string[] = [];
    const w = worker(backend, { log });
    const first = await w.pass();
    await w.idle();
    assert.deepEqual(first.started, [ID_A]);
    assert.deepEqual(
      first.waiting?.map((wait) => [wait.taskId, wait.reason]),
      [
        [ID_B, `waiting on ${ID_A} (open)`],
        [ID_C, "all 2 attempt(s) are used"],
      ],
    );
    assert.deepEqual(first.skipped, [], "not ready is not a refusal");
    const claimed = calls.filter((c) => c.method === "taskClaim").map((c) => c.params["taskId"]);
    assert.deepEqual(claimed, [ID_A]);

    // A second pass logs nothing new about the same waiting tasks.
    tasks[0] = { id: ID_A, state: "completed", hidden: true };
    const before = log.length;
    await w.pass();
    assert.equal(log.filter((line) => line.includes("not ready")).length, 2);
    assert.ok(log.slice(before).every((line) => !line.includes("not ready")));
  });

  it("names the missing capability when offered work requires one it lacks", async () => {
    const { backend } = fakeBackend([{ id: ID_A, ready: false, requires: ["gpu"] }]);
    const report = await worker(backend).pass();
    assert.match(report.waiting?.[0]?.reason ?? "", /requires gpu, which worker.capabilities/);
  });

  it("asks the agenda with its capabilities and takes capable work as well as offered", async () => {
    const tasks: FakeTask[] = [
      { id: ID_A, relation: "capable", requires: ["gpu"] },
      { id: ID_B, relation: "unclaimed" },
    ];
    const claims: Record<string, unknown>[] = [];
    const { backend, calls } = fakeBackend(tasks, { onClaim: (p) => claims.push(p) });
    const w = worker(backend, { policy: { capabilities: ["gpu", "macos"] } });
    const report = await w.pass();
    await w.idle();

    const agenda = calls.find((c) => c.method === "agenda");
    assert.deepEqual(agenda?.params, { includeUnclaimed: false, includeCapable: ["gpu", "macos"] });
    assert.deepEqual(report.started, [ID_A], "plain free work is still left alone");
    assert.deepEqual(claims[0]?.["capabilities"], ["gpu", "macos"]);
  });

  it("does not send capabilities on the claim or the agenda when it declares none", async () => {
    const claims: Record<string, unknown>[] = [];
    const { backend, calls } = fakeBackend([{ id: ID_A }], { onClaim: (p) => claims.push(p) });
    const w = worker(backend);
    await w.pass();
    await w.idle();
    assert.deepEqual(calls.find((c) => c.method === "agenda")?.params, { includeUnclaimed: false });
    assert.equal("capabilities" in (claims[0] ?? {}), false);
    assert.ok(!calls.some((c) => c.method.startsWith("profile")));
  });

  it("adds missing capabilities to the profile once, keeping what is there", async () => {
    const { backend, calls, profile } = fakeBackend([], {
      profile: { capabilities: ["Reads Rust fluently", "gpu"] },
    });
    const w = worker(backend, { policy: { capabilities: ["gpu", "macos"] } });
    await w.pass();
    await w.pass();
    const updates = calls.filter((c) => c.method === "profileUpdate");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]?.params, {
      input: { capabilities: ["Reads Rust fluently", "gpu", "macos"] },
    });
    assert.deepEqual(profile()?.capabilities, ["Reads Rust fluently", "gpu", "macos"]);
    assert.equal(calls.filter((c) => c.method === "profileGet").length, 1);
  });

  it("does not write the profile when it already lists every capability", async () => {
    const { backend, calls } = fakeBackend([], { profile: { capabilities: ["gpu"] } });
    const w = worker(backend, { policy: { capabilities: ["gpu"] } });
    await w.pass();
    assert.ok(!calls.some((c) => c.method === "profileUpdate"));
  });

  for (const code of ["DEPENDENCY_PENDING", "ATTEMPTS_EXHAUSTED", "CAPABILITY_MISSING"]) {
    it(`treats ${code} as an expected race: logged once, nothing run`, async () => {
      const { backend } = fakeBackend([{ id: ID_A }], {
        onClaim: () => {
          throw coded(code, "refused by the graph");
        },
      });
      const log: string[] = [];
      let ran = false;
      const w = worker(backend, {
        log,
        executor: async () => {
          ran = true;
          return result();
        },
      });
      const one = await w.pass();
      const two = await w.pass();
      await w.idle();
      assert.equal(ran, false);
      assert.deepEqual(one.started, []);
      assert.match(one.skipped[0]?.reason ?? "", /refused by the graph/);
      assert.equal(two.skipped.length, 1);
      assert.equal(log.filter((line) => line.includes("refused by the graph")).length, 1);
    });
  }
});

describe("retries", () => {
  it("picks release while attempts remain, block otherwise", () => {
    const retry = { backoffMinutes: 10 };
    assert.deepEqual(failureAction({ attempt: 1, maxAttempts: 3 }, retry), {
      action: "released",
    });
    assert.deepEqual(failureAction({ attempt: 3, maxAttempts: 3 }, retry), {
      action: "blocked",
      needsHuman: true,
      reason: "all 3 attempt(s) are used",
    });
    // No limit: an unbounded release loop is not a default anybody chose.
    assert.equal(failureAction({ attempt: 1 }, retry).action, "blocked");
    assert.equal(
      failureAction({ attempt: 1 }, { ...retry, onFailure: "release" }).action,
      "released",
    );
    assert.equal(
      failureAction({ attempt: 1, maxAttempts: 3 }, { ...retry, onFailure: "block" }).action,
      "blocked",
    );
    // Exhausted wins over the policy: releasing would leave it unclaimable.
    assert.equal(
      failureAction({ attempt: 2, maxAttempts: 2 }, { ...retry, onFailure: "release" }).action,
      "blocked",
    );
  });

  it("releases a failed run with attempts left, and waits out the backoff before reclaiming", async () => {
    let now = Date.parse("2026-11-03T10:00:00.000Z");
    const tasks: FakeTask[] = [{ id: ID_A, attempt: 0, maxAttempts: 3 }];
    const { backend, calls, updates } = fakeBackend(tasks);
    const w = worker(backend, {
      now: () => now,
      executor: async () => result({ exitCode: 1, stdoutTail: "flaky test failed" }),
    });
    await w.pass();
    await w.idle();
    const released = updates().at(-1);
    assert.equal(released?.action, "released");
    assert.match(released?.body ?? "", /exited with code 1/);
    assert.match(released?.body ?? "", /attempt 1 of 3/);
    assert.match(released?.body ?? "", /flaky test failed/);
    assert.equal(released?.needsHuman, undefined);
    assert.equal((await listRuns(home))[0]?.outcome, "released");

    // The task is open again with one attempt used. This machine waits.
    tasks[0] = { id: ID_A, attempt: 1, maxAttempts: 3 };
    now += 5 * 60_000;
    const early = await w.pass();
    assert.deepEqual(early.started, []);
    assert.match(early.skipped[0]?.reason ?? "", /not retried on this machine before/);
    assert.equal(calls.filter((c) => c.method === "taskClaim").length, 1);

    // The wait survives a restart: it is on disk, not in this process.
    const saved = JSON.parse(await readFile(join(home, "runs", "retry-after.json"), "utf8"));
    assert.ok(typeof saved[ID_A] === "string");
    const restarted = worker(backend, { now: () => now, executor: async () => result() });
    assert.deepEqual((await restarted.pass()).started, []);

    now += 6 * 60_000;
    const later = await restarted.pass();
    await restarted.idle();
    assert.deepEqual(later.started, [ID_A]);
    assert.equal(updates().at(-1)?.action, "completed");
  });

  it("blocks with needs:human when the last attempt fails", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_A, attempt: 1, maxAttempts: 2 }]);
    const w = worker(backend, {
      executor: async () => result({ timedOut: true, exitCode: null, signal: "SIGTERM" }),
    });
    await w.pass();
    await w.idle();
    const last = updates().at(-1);
    assert.equal(last?.action, "blocked");
    assert.equal(last?.needsHuman, true);
    assert.match(last?.body ?? "", /exceeded its 60 minute limit/);
    assert.match(last?.body ?? "", /all 2 attempt\(s\) are used/);
  });

  it("keeps blocking a failed task without maxAttempts, as before", async () => {
    const { backend, updates } = fakeBackend([{ id: ID_D }]);
    const w = worker(backend, { executor: async () => result({ exitCode: 2 }) });
    await w.pass();
    await w.idle();
    const last = updates().at(-1);
    assert.equal(last?.action, "blocked");
    assert.equal(last?.needsHuman, undefined);
  });

  it("forgets an expired backoff and drops it from the file", async () => {
    let now = 1_000_000;
    const backoff = new RetryBackoff(home, () => now);
    await backoff.set(ID_A, 1);
    await backoff.set(ID_B, 0);
    assert.ok((await backoff.until(ID_A)) !== null);
    assert.equal(await backoff.until(ID_B), null);
    now += 2 * 60_000;
    assert.equal(await backoff.until(ID_A), null);
    await backoff.set(ID_C, 5);
    const saved = JSON.parse(await readFile(join(home, "runs", "retry-after.json"), "utf8"));
    assert.deepEqual(Object.keys(saved), [ID_C]);
  });
});

describe("selection rules", () => {
  it("carries the attempt count and limit on a candidate", () => {
    const agenda = {
      entries: [
        {
          room: "ops",
          relation: "offered",
          ready: true,
          status: {
            task: { id: ID_A, title: "t", creator: "x", state: "open", attempt: 1, maxAttempts: 3 },
            definition: "Go.",
            waitingOn: [],
            children: [],
          },
        },
      ],
    } as unknown as Parameters<typeof selectCandidates>[0];
    const [candidate] = selectCandidates(agenda, policy()).candidates;
    assert.equal(candidate?.attempt, 1);
    assert.equal(candidate?.maxAttempts, 3);
    assert.equal(candidate?.relation, "offered");
  });
});
