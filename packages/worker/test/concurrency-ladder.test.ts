/**
 * The concurrency ladder, measured rather than asserted.
 *
 * Every rung starts a real worker pass with a fake runner that records when it
 * starts and ends, and the test checks that the runs really overlapped: the
 * observed peak has to reach the limit, at every one of 5, 8, 12, 16 and 20.
 * A budget that admits `concurrency` runs but start them one after another
 * would pass a count check and fail this one.
 *
 * The runner is `process.execPath` with a short sleep script, so no paid model
 * is involved and nothing reaches the network. It is not a load test: the
 * point is the gate, not throughput.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Agenda, WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import type { Executor, RunRequest, RunResult } from "../src/runner.ts";
import { Worker } from "../src/worker.ts";

const LADDER = [5, 8, 12, 16, 20] as const;
const IDBase = "01JLADDER";

function taskId(n: number): string {
  return `${IDBase}${String(n).padStart(15, "0")}`;
}

/** An agenda with `count` ready tasks offered here, each its own task. */
function agendaOf(count: number): Agenda {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      room: "ops",
      relation: "offered",
      inFlight: false,
      needsAttention: false,
      ready: true,
      status: {
        task: {
          id: taskId(index),
          title: `ladder ${String(index)}`,
          creator: "alice-claude",
          state: "open",
        },
        definition: "Hold a slot.",
        waitingOn: [],
        children: [],
      },
    })),
    counts: {},
    inFlightThreads: [],
  } as unknown as Agenda;
}

function policy(concurrency: number): WorkerPolicy {
  return {
    enabled: true,
    // The hourly cap must not be what stops the ladder.
    concurrency,
    maxPerHour: 120,
    timeoutMinutes: 60,
    runners: { hold: { argv: ["claude", "-p"], worktree: false } },
    defaultRunner: "hold",
    trustedRequesters: [],
    onAbandon: "release",
    capabilities: [],
    retry: { backoffMinutes: 10 },
    followupDays: 14,
    tiers: [],
    escalation: { maxSteps: 0 },
  };
}

interface Timing {
  taskId: string;
  started: number;
  ended: number;
}

/**
 * An executor that records its own start and end, then waits `holdMs`.
 *
 * It counts the runs in flight when it starts, so the peak is the number that
 * were truly concurrent rather than the number that were admitted.
 */
function overlapExecutor(
  holdMs: number,
  timings: Timing[],
  peak: { value: number },
  expected: number,
): Executor {
  let inFlight = 0;
  let release: () => void = () => undefined;
  // Nothing ends until `expected` runs have started: how long a loaded machine takes to
  // admit them is not what this test measures. A gate that admits fewer never opens this,
  // so the timeout lets it end and the peak assertions report the shortfall.
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, 10_000).unref();
  });
  return async (request: RunRequest): Promise<RunResult> => {
    inFlight += 1;
    peak.value = Math.max(peak.value, inFlight);
    if (inFlight >= expected) release();
    await allStarted;
    const started = Date.now();
    await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
    inFlight -= 1;
    const ended = Date.now();
    const taskId = request.env?.["OGURI_TASK_ID"] ?? "";
    timings.push({ taskId, started, ended });
    await mkdir(request.logDir, { recursive: true });
    await writeFile(join(request.logDir, "stdout.log"), "held");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: ended - started,
      stdoutTail: "held",
    };
  };
}

/** The largest number of recorded runs whose intervals share an instant. */
function observedPeak(timings: readonly Timing[]): number {
  const edges = timings.flatMap((t) => [
    { at: t.started, delta: 1 },
    { at: t.ended, delta: -1 },
  ]);
  // An end before a start at the same millisecond means no real overlap.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const edge of edges) {
    current += edge.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function backendFor(agenda: Agenda): Backend {
  return {
    mode: "direct",
    async call<T>(method: string): Promise<T> {
      if (method === "agenda") return agenda as T;
      if (method === "taskShow") {
        // Every task stays ours while its run is in flight; nothing cancels it.
        return { task: { state: "in_progress", assignee: "bob-claude" }, children: [] } as T;
      }
      if (method === "taskClaim") return { header: { task: { attempt: 1 } } } as T;
      if (method === "profileGet") return { capabilities: [] } as T;
      return {} as T;
    },
    async networks() {
      return [];
    },
    async close() {},
  };
}

describe("concurrency ladder", () => {
  // A rung gets its own home: the worker seeds its hourly budget from the run
  // records there, so a shared directory would make each rung inherit the last
  // one's starts and hit `maxPerHour` instead of `concurrency`.
  let homes: string[] = [];
  const newHome = async (): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), "oguri-ladder-"));
    homes.push(home);
    return home;
  };
  after(async () => {
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  });

  for (const limit of LADDER) {
    it(`runs ${String(limit)} at once, with the runs genuinely overlapping`, async () => {
      const timings: Timing[] = [];
      const peak = { value: 0 };
      const worker = new Worker({
        backend: backendFor(agendaOf(limit)),
        agentId: "bob-claude",
        machineId: "ladder-01",
        home: await newHome(),
        loadPolicy: async () => policy(limit),
        executor: overlapExecutor(150, timings, peak, limit),
      });
      const report = await worker.pass();
      // The pass starts every run it admitted; none waits for another pass.
      assert.equal(report.started.length, limit, "every task was admitted in one pass");
      await worker.idle();

      assert.equal(timings.length, limit, "every admitted run really ended");
      assert.equal(peak.value, limit, "they were all in flight at the same moment");
      assert.equal(observedPeak(timings), limit, "the recorded intervals overlap");

      // One more task than the limit: the gate stops the extra one instead of
      // quietly running it.
      const nextTimings: Timing[] = [];
      const nextPeak = { value: 0 };
      const busy = new Worker({
        backend: backendFor(agendaOf(limit + 1)),
        agentId: "bob-claude",
        machineId: "ladder-01",
        home: await newHome(),
        loadPolicy: async () => policy(limit),
        executor: overlapExecutor(150, nextTimings, nextPeak, limit),
      });
      const gated = await busy.pass();
      assert.equal(gated.started.length, limit, "the gate admits exactly the limit");
      assert.match(gated.limited ?? "", /slot/, "and says what stopped it");
      await busy.idle();
      assert.equal(nextPeak.value, limit);
    });
  }
});
