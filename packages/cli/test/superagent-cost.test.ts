import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { localDate } from "@oguri/worker";

/**
 * `oguri superagent status` says what today cost, end to end.
 *
 * The runs are written by hand under a fresh home rather than started, because
 * what is under test is the read: a run's price is whatever its own
 * stdout.log says, and nothing else on this machine knows it.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

let tmp: string;
let home: string;
let remote: string;

async function oguri(...args: string[]): Promise<string> {
  const env = {
    ...process.env,
    OGURI_HOME: home,
    NO_COLOR: "1",
    OGURI_MACHINE_ID: "laptop",
  };
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
  return stdout;
}

interface RunSpec {
  task: string;
  run: string;
  startedAt: Date;
  stdout?: string;
}

async function writeRun(spec: RunSpec): Promise<void> {
  const dir = join(home, "runs", spec.task, spec.run);
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
    }),
  );
  if (spec.stdout !== undefined) await writeFile(join(dir, "stdout.log"), spec.stdout);
}

/** A run of its own session, so its figure is that session's whole bill. */
const claudeJson = (cost: number, session = `s-${String(cost)}`): string =>
  JSON.stringify({ type: "result", session_id: session, result: "done", total_cost_usd: cost });

/** Each case starts from no runs, so one test's figures never leak into the next. */
async function resetRuns(): Promise<void> {
  await rm(join(home, "runs"), { recursive: true, force: true });
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-superagent-cost-"));
  home = join(tmp, "home");
  remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri("init", "--repo", remote, "--network", "home", "--agent", "alice-claude");
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("superagent status: today's runs", () => {
  it("adds the price the runs' own logs report", async () => {
    await resetRuns();
    const now = new Date();
    await writeRun({ task: "01JA", run: "r1", startedAt: now, stdout: claudeJson(0.25) });
    await writeRun({ task: "01JA", run: "r2", startedAt: now, stdout: claudeJson(0.5) });
    const shown = await oguri("superagent", "status");
    assert.match(shown, /today\s+2 worker run\(s\) · \$0\.75/);
  });

  it("counts a resumed session once, not once per run", async () => {
    // A resumed turn prints the session's whole spend, so summing runs would
    // report the same money three times. This is the figure a person budgets by.
    await resetRuns();
    const now = new Date();
    const session = (cost: number): string =>
      JSON.stringify({ type: "result", session_id: "one", result: "done", total_cost_usd: cost });
    await writeRun({ task: "01JE", run: "r1", startedAt: now, stdout: session(2.418752) });
    await writeRun({ task: "01JE", run: "r2", startedAt: now, stdout: session(10.922321) });
    await writeRun({ task: "01JE", run: "r3", startedAt: now, stdout: session(25.440337) });
    const shown = await oguri("superagent", "status");
    // Every one of the three runs is inside the figure, so it is a total.
    assert.match(shown, /today\s+3 worker run\(s\) · \$25\.44 total\n/);
  });

  it("calls the figure a subtotal and counts what it leaves out", async () => {
    // The run without a price is real spend this figure does not cover. Saying
    // "total" here would be a claim the logs do not support.
    await resetRuns();
    const now = new Date();
    await writeRun({ task: "01JF", run: "r1", startedAt: now, stdout: claudeJson(0.4) });
    await writeRun({ task: "01JF", run: "r2", startedAt: now, stdout: "no price printed\n" });
    await writeRun({ task: "01JF", run: "r3", startedAt: now, stdout: "plain output\n" });
    const shown = await oguri("superagent", "status");
    assert.match(
      shown,
      /today\s+3 worker run\(s\) · \$0\.40 known subtotal · 2 run\(s\) unpriced\n/,
    );
    assert.ok(
      !/known subtotal[^\n]*\btotal\b/.test(shown),
      "a subtotal is never also called a total",
    );
    assert.match(shown, /worker runs only; excludes Big\/Small superagent brain sessions/);
  });

  it("shows the count without a figure when no log carries a price", async () => {
    await resetRuns();
    const now = new Date();
    await writeRun({ task: "01JB", run: "r1", startedAt: now, stdout: "plain output\n" });
    const shown = await oguri("superagent", "status");
    assert.match(shown, /today\s+1 worker run\(s\)\n/);
    assert.doesNotMatch(shown, /today\s+\d+ worker run\(s\) · \$/);
  });

  it("leaves yesterday's runs out of today", async () => {
    await resetRuns();
    await writeRun({
      task: "01JC",
      run: "r1",
      startedAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
      stdout: claudeJson(7),
    });
    const shown = await oguri("superagent", "status");
    assert.match(shown, /today\s+0 worker run\(s\)\n/);
    assert.doesNotMatch(shown, /\$7/);
  });

  it("carries the same figures in --json", async () => {
    await resetRuns();
    const now = new Date();
    await writeRun({ task: "01JD", run: "r1", startedAt: now, stdout: claudeJson(0.25) });
    await writeRun({ task: "01JD", run: "r2", startedAt: now, stdout: claudeJson(0.5) });
    const shown = JSON.parse(await oguri("superagent", "status", "--json")) as {
      today: { date: string; runs: number; costUsd: number | null };
    };
    assert.equal(shown.today.date, localDate(new Date()));
    assert.equal(shown.today.runs, 2);
    assert.equal(shown.today.costUsd, 0.75);
  });
});
