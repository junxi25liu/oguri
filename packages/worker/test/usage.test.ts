import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { localDate, parseRunOutput, parseTotalCost, todayUsage } from "../src/usage.ts";

/**
 * What today's runs cost, read from the local logs.
 *
 * The figures are only ever shown, never published, and a runner that prints
 * no price must not be counted as free — so the distinction between "no runs"
 * and "runs whose price could not be read" is what these tests pin down.
 */

let tmp: string;
let home: string;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-usage-"));
  home = join(tmp, "home");
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
}

interface RunSpec {
  task: string;
  /** Absent writes the older per-task layout. */
  run?: string;
  startedAt: Date;
  /** The exact log text; absent writes no log at all. */
  stdout?: string;
  /** Extra fields on the record, such as a session id or an outcome. */
  record?: Record<string, unknown>;
}

async function writeRun(spec: RunSpec): Promise<void> {
  const dir =
    spec.run === undefined
      ? join(home, "runs", spec.task)
      : join(home, "runs", spec.task, spec.run);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      taskId: spec.task,
      room: "ops",
      title: "a task",
      runner: "claude",
      startedAt: spec.startedAt.toISOString(),
      outcome: "completed",
      ...spec.record,
    }),
  );
  if (spec.stdout !== undefined) await writeFile(join(dir, "stdout.log"), spec.stdout);
}

const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime();
const TODAY = new Date(2026, 10, 4, 9, 30, 0);
const YESTERDAY = new Date(2026, 10, 3, 23, 30, 0);

const claudeJson = (cost: number, session = "abc"): string =>
  JSON.stringify({ type: "result", session_id: session, result: "done", total_cost_usd: cost });

describe("parseTotalCost", () => {
  it("reads the total from a claude JSON object", () => {
    assert.equal(parseTotalCost(claudeJson(0.1234)), 0.1234);
  });

  it("reads it past a plain notice printed first", () => {
    // Observed: Claude Code puts a billing/update notice on stdout before its
    // JSON. The JSON is then the last line that parses.
    assert.equal(parseTotalCost(`Billing note: you are on a plan.\n${claudeJson(0.5)}\n`), 0.5);
  });

  it("reads the stream-json result event, which is the last one", () => {
    const stream = [
      JSON.stringify({ type: "system", session_id: "abc", total_cost_usd: 0.01 }),
      JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.42 }),
    ].join("\n");
    assert.equal(parseTotalCost(stream), 0.42);
  });

  it("returns null for output that carries no price at all", () => {
    // Codex, and a plain `claude -p`, print no cost.
    assert.equal(parseTotalCost('{"type":"item.completed","item":{"text":"hi"}}'), null);
    assert.equal(parseTotalCost("done.\n"), null);
    assert.equal(parseTotalCost(""), null);
  });

  it("refuses a value that is not a finite non-negative number", () => {
    assert.equal(parseTotalCost('{"total_cost_usd":"0.40"}'), null);
    assert.equal(parseTotalCost('{"total_cost_usd":-1}'), null);
    assert.equal(parseTotalCost('{"total_cost_usd":null}'), null);
  });

  it("does not mistake an unrelated number for the price", () => {
    assert.equal(parseTotalCost('{"cost_usd":1.5,"duration_ms":900}'), null);
  });
});

describe("todayUsage", () => {
  it("counts nothing when there are no runs at all", async () => {
    await reset();
    assert.deepEqual(await todayUsage(home, NOW), {
      date: "2026-11-04",
      runs: 0,
      costUsd: null,
      unpricedRuns: 0,
    });
  });

  it("counts only runs that started today, and sums their cost", async () => {
    await reset();
    // Distinct sessions, so each figure is that session's whole bill.
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: claudeJson(0.25, "s1") });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: claudeJson(0.5, "s2") });
    await writeRun({ task: "b", run: "r1", startedAt: YESTERDAY, stdout: claudeJson(9, "s3") });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 2);
    assert.equal(usage.costUsd, 0.75);
    assert.equal(usage.unpricedRuns, 0, "both runs are inside the figure");
  });

  it("counts a run whose price cannot be read, keeping the cost null", async () => {
    // The whole point: a run with no price is not a $0.00 run.
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: "done.\n" });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 2);
    assert.equal(usage.costUsd, null);
  });

  it("still reports the cost of the runs that did carry one", async () => {
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: claudeJson(0.25) });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: '{"type":"x"}' });
    assert.equal((await todayUsage(home, NOW)).costUsd, 0.25);
  });

  it("reads the older per-task layout too", async () => {
    await reset();
    await writeRun({ task: "old", startedAt: TODAY, stdout: claudeJson(0.1) });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 1);
    assert.equal(usage.costUsd, 0.1);
  });

  it("falls back to the log's mtime when the record is unreadable", async () => {
    await reset();
    const dir = join(home, "runs", "a", "r1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), "{not json");
    await writeFile(join(dir, "stdout.log"), claudeJson(0.3));
    const usage = await todayUsage(home, Date.now());
    assert.equal(usage.runs, 1);
    assert.equal(usage.costUsd, 0.3);
  });

  it("ignores a directory that is not a run", async () => {
    await reset();
    await mkdir(join(home, "runs", "a", "notes"), { recursive: true });
    await writeFile(join(home, "runs", "a", "consumed.json"), "[]");
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 0);
    assert.equal(usage.costUsd, null);
  });
});

describe("a session that ran several times", () => {
  // Observed on this machine: one task resumed twice printed $2.42, then
  // $10.92, then $25.44 — three figures for one session, each cumulative.
  it("counts a resumed session once, by its final cumulative figure", async () => {
    await reset();
    const task = "KT";
    await writeRun({ task, run: "r1", startedAt: TODAY, stdout: claudeJson(2.418752, "s1") });
    await writeRun({ task, run: "r2", startedAt: TODAY, stdout: claudeJson(10.922321, "s1") });
    await writeRun({ task, run: "r3", startedAt: TODAY, stdout: claudeJson(25.440337, "s1") });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 3);
    assert.equal(usage.costUsd, 25.440337, "not 38.78, which is the sum of cumulative figures");
  });

  it("adds separate sessions together", async () => {
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: claudeJson(3, "s1") });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: claudeJson(5, "s1") });
    await writeRun({ task: "b", run: "r1", startedAt: TODAY, stdout: claudeJson(7.4, "s2") });
    assert.equal((await todayUsage(home, NOW)).costUsd, 12.4);
  });

  it("counts only what the session spent today, not its whole life", async () => {
    await reset();
    // A session started yesterday spent $9 then; today's turn brings it to $12.
    await writeRun({ task: "a", run: "r1", startedAt: YESTERDAY, stdout: claudeJson(9, "s1") });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: claudeJson(12, "s1") });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 1);
    assert.equal(usage.costUsd, 3);
  });

  it("takes a finished run's recorded price over its pruned log", async () => {
    await reset();
    await writeRun({
      task: "a",
      run: "r1",
      startedAt: TODAY,
      record: { sessionId: "s1", costUsd: 4.5 },
    });
    await writeRun({
      task: "a",
      run: "r2",
      startedAt: TODAY,
      record: { sessionId: "s1", costUsd: 6 },
    });
    assert.equal((await todayUsage(home, NOW)).costUsd, 6);
  });

  it("leaves out a session whose only today run is still in flight", async () => {
    // Its price is not final, and counting it would double-count yesterday's.
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: YESTERDAY, stdout: claudeJson(9, "s1") });
    await writeRun({
      task: "a",
      run: "r2",
      startedAt: TODAY,
      stdout: claudeJson(11, "s1"),
      record: { sessionId: "s1", outcome: "running" },
    });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 1);
    assert.equal(usage.costUsd, null);
  });

  it("does not merge two runs that report no session", async () => {
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: '{"total_cost_usd":2}' });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: '{"total_cost_usd":3}' });
    assert.equal((await todayUsage(home, NOW)).costUsd, 5);
  });
});

describe("what the subtotal leaves out", () => {
  it("counts an unpriced run, so the figure is never read as a total", async () => {
    // Codex and a plain `claude -p` print no price. Their spend is real and
    // outside the number; a caller that shows only the number overstates it.
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: claudeJson(0.4, "s1") });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: "plain output\n" });
    await writeRun({ task: "a", run: "r3", startedAt: TODAY });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.runs, 3);
    assert.equal(usage.costUsd, 0.4);
    assert.equal(
      usage.unpricedRuns,
      2,
      "the two runs with no price are named, not silently dropped",
    );
  });

  it("counts a run still in flight, whose spend is not final", async () => {
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: claudeJson(1, "s1") });
    await writeRun({
      task: "a",
      run: "r2",
      startedAt: TODAY,
      stdout: claudeJson(2, "s2"),
      record: { sessionId: "s2", outcome: "running" },
    });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.costUsd, 1);
    assert.equal(usage.unpricedRuns, 1);
  });

  it("says nothing is left out only when every run is priced", async () => {
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: claudeJson(1, "s1") });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: claudeJson(2, "s1") });
    assert.equal((await todayUsage(home, NOW)).unpricedRuns, 0);
  });

  it("counts every run when no price was reported at all", async () => {
    await reset();
    await writeRun({ task: "a", run: "r1", startedAt: TODAY, stdout: "plain\n" });
    await writeRun({ task: "a", run: "r2", startedAt: TODAY, stdout: "plain\n" });
    const usage = await todayUsage(home, NOW);
    assert.equal(usage.costUsd, null);
    assert.equal(usage.unpricedRuns, 2);
  });
});

describe("parseRunOutput", () => {
  it("reads the session and the price from one result event", () => {
    assert.deepEqual(parseRunOutput(claudeJson(1.5, "s9")), { sessionId: "s9", costUsd: 1.5 });
  });

  it("keeps the price from a log that names no session", () => {
    assert.deepEqual(parseRunOutput('{"total_cost_usd":2.5}'), { costUsd: 2.5 });
  });

  it("keeps the session from a log that names no price", () => {
    // A cheap model behind an Anthropic-compatible endpoint prints the id and
    // no price at all; the run is still attributable to its session.
    assert.deepEqual(parseRunOutput('{"type":"result","session_id":"s3","result":"ok"}'), {
      sessionId: "s3",
    });
  });

  it("returns nothing for output that carries neither", () => {
    assert.deepEqual(parseRunOutput("done.\n"), {});
  });
});

describe("localDate", () => {
  it("is the local calendar day, not UTC", () => {
    // Constructed as local time, so midnight and the last hour of a day stay
    // on their own day wherever the machine is.
    assert.equal(localDate(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01");
    assert.equal(localDate(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31");
  });
});
