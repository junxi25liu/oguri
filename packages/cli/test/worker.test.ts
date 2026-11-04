import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * The worker end to end: one agent posts a task to another machine, the worker
 * there claims it, runs an allow-listed executor, and the result comes back
 * through git. No daemon, no mocks — the same path a person would use.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

let tmp: string;
let remote: string;
let aliceHome: string;
let bobHome: string;

async function oguri(home: string, ...args: string[]): Promise<Result> {
  const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const alice = (...args: string[]) => oguri(aliceHome, ...args);
const bob = (...args: string[]) => oguri(bobHome, ...args);

function parseJson<T>(result: Result): T {
  assert.equal(result.code, 0, `expected success, got ${String(result.code)}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

/** An executor that proves it read the task from stdin. */
const ECHO_RUNNER = [
  process.execPath,
  "-e",
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('WORKER SAW: '+s.trim()))",
];

async function setBobPolicy(trusted: string[], concurrency = 1): Promise<void> {
  await writeFile(
    join(bobHome, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      `  concurrency: ${String(concurrency)}`,
      "  timeoutMinutes: 1",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  runners:",
      `    echo: ${JSON.stringify(ECHO_RUNNER)}`,
      `  trustedRequesters: ${JSON.stringify(trusted)}`,
      "",
    ].join("\n"),
  );
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-worker-e2e-"));
  remote = join(tmp, "transport.git");
  aliceHome = join(tmp, "alice");
  bobHome = join(tmp, "bob");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  assert.equal(
    (await alice("init", "--repo", remote, "--network", "acme", "--agent", "alice-claude")).code,
    0,
  );
  assert.equal((await alice("room", "create", "ops", "--title", "Ops")).code, 0);
  assert.equal(
    (await bob("init", "--repo", remote, "--network", "acme", "--agent", "bob-claude")).code,
    0,
  );
  assert.equal((await bob("room", "join", "ops")).code, 0);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri worker, end to end", () => {
  it("refuses to start until the machine owner enables it", async () => {
    const result = await bob("worker", "start", "--once");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /worker is disabled/);
  });

  it("leaves an untrusted remote task waiting for approval", async () => {
    await setBobPolicy([]);
    const created = parseJson<{ task: { id: string } }>(
      await alice(
        "task",
        "create",
        "ops",
        "Report the disk usage.",
        "--title",
        "Disk",
        "--target",
        "bob-claude",
        "--json",
      ),
    );
    const run = await bob("worker", "start", "--once");
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /awaiting approval/);

    const shown = parseJson<{ task: { state: string } }>(
      await bob("task", "show", "ops", created.task.id, "--json"),
    );
    assert.equal(shown.task.state, "open");
  });

  it("runs a trusted task and reports the result back to the requester", async () => {
    // The Disk task from the previous case is now trusted too; room for both.
    await setBobPolicy(["alice-claude"], 2);
    const created = parseJson<{ task: { id: string } }>(
      await alice(
        "task",
        "create",
        "ops",
        "runner: echo\nSummarise the release notes.",
        "--title",
        "Notes",
        "--target",
        "bob-claude",
        "--json",
      ),
    );
    // Two tasks are ready, and a claim can lose a push race with the first
    // run's own progress; the next pass takes it. A run is recorded on bob's
    // machine before its completion reaches the transport, so wait for what
    // the requester sees, not for bob's local record. Pass until both hold.
    const completedRuns = async (): Promise<number> =>
      parseJson<{ outcome: string }[]>(await bob("worker", "runs", "--json")).filter(
        (r) => r.outcome === "completed",
      ).length;
    const stateSeenByAlice = async (): Promise<string> => {
      assert.equal((await alice("sync")).code, 0);
      return parseJson<{ task: { state: string } }>(
        await alice("task", "show", "ops", created.task.id, "--json"),
      ).task.state;
    };
    for (let i = 0; i < 8; i += 1) {
      const run = await bob("worker", "start", "--once");
      assert.equal(run.code, 0, run.stderr);
      assert.equal((await bob("sync")).code, 0);
      if ((await completedRuns()) >= 2 && (await stateSeenByAlice()) === "completed") break;
    }

    assert.equal((await alice("sync")).code, 0);
    const detail = parseJson<{
      task: { state: string; assignee: string };
      events: { action: string; body: string }[];
    }>(await alice("task", "show", "ops", created.task.id, "--json"));
    assert.equal(detail.task.state, "completed");
    assert.equal(detail.task.assignee, "bob-claude");
    const done = detail.events.at(-1);
    assert.equal(done?.action, "completed");
    assert.match(done?.body ?? "", /WORKER SAW: Summarise the release notes\./);
    assert.doesNotMatch(done?.body ?? "", /runner: echo/);

    const runs = parseJson<{ taskId: string; outcome: string }[]>(
      await bob("worker", "runs", "--json"),
    );
    assert.ok(runs.some((r) => r.taskId === created.task.id && r.outcome === "completed"));
    assert.equal(runs.filter((r) => r.outcome === "completed").length, 2);
  });
});

describe("oguri worker, after a crash", () => {
  /** A runner that writes its pid where the test can find it, then waits a long time. */
  const SLEEPER = [
    process.execPath,
    "-e",
    "require('fs').writeFileSync(process.env.OGURI_RUN_DIR + '/runner.pid', String(process.pid)); setTimeout(() => {}, 120000)",
  ];

  async function setSleeperPolicy(): Promise<void> {
    await writeFile(
      join(bobHome, "policy.yaml"),
      [
        "v: 1",
        "worker:",
        "  enabled: true",
        "  maxPerHour: 120",
        "  timeoutMinutes: 5",
        `  workdir: ${JSON.stringify(tmp)}`,
        "  runners:",
        `    sleeper: ${JSON.stringify(SLEEPER)}`,
        "  defaultRunner: sleeper",
        '  trustedRequesters: ["alice-claude"]',
        "",
      ].join("\n"),
    );
  }

  async function createTask(title: string): Promise<string> {
    const created = parseJson<{ task: { id: string } }>(
      await alice(
        "task",
        "create",
        "ops",
        "Wait.",
        "--title",
        title,
        "--target",
        "bob-claude",
        "--json",
      ),
    );
    return created.task.id;
  }

  /** Start a long-lived worker and wait until its run has an executor. */
  async function startUntilRunning(taskId: string) {
    const child = spawn(process.execPath, [CLI, "worker", "start", "--direct"], {
      env: testEnv({ OGURI_HOME: bobHome, NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const deadline = Date.now() + 30_000;
    for (;;) {
      const runs = parseJson<{ taskId: string; outcome: string; runId: string }[]>(
        await bob("worker", "runs", "--json"),
      );
      const run = runs.find((r) => r.taskId === taskId && r.outcome === "running");
      if (run !== undefined) {
        const pidFile = join(bobHome, "runs", taskId, run.runId, "runner.pid");
        try {
          const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
          if (pid > 0) return { child, exited, pid, output: () => output };
        } catch {
          // Not written yet.
        }
      }
      if (Date.now() > deadline) throw new Error(`the run never started:\n${output}`);
      await sleep(200);
    }
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function taskOf(id: string) {
    assert.equal((await alice("sync")).code, 0);
    return parseJson<{ task: { state: string; assignee?: string }; events: { action: string }[] }>(
      await alice("task", "show", "ops", id, "--json"),
    );
  }

  it("releases a task whose worker was killed, and stops the orphaned run", async () => {
    await setSleeperPolicy();
    const id = await createTask("Crash");
    const worker = await startUntilRunning(id);
    worker.child.kill("SIGKILL");
    await worker.exited;
    // The executor leads its own process group, so it outlives a killed worker.
    assert.ok(alive(worker.pid), "the orphan is still running before recovery");

    // Nothing else is offered, so recovery is all this start does.
    const restart = await bob("worker", "start", "--once");
    assert.equal(restart.code, 0, restart.stderr);
    assert.match(restart.stdout, /recovered/);
    for (let i = 0; i < 50 && alive(worker.pid); i++) await sleep(100);
    assert.equal(alive(worker.pid), false, "recovery kills an executor nobody supervises");

    const detail = await taskOf(id);
    assert.equal(detail.task.state, "open");
    assert.equal(detail.task.assignee, undefined);
    assert.equal(detail.events.at(-1)?.action, "released");
    const runs = parseJson<{ taskId: string; outcome: string }[]>(
      await bob("worker", "runs", "--json"),
    );
    assert.ok(runs.some((r) => r.taskId === id && r.outcome === "abandoned"));
    assert.match((await bob("worker", "runs")).stdout, /abandoned/);

    // Cancelled so later cases do not pick it up again.
    assert.equal((await alice("task", "update", "ops", id, "cancelled", "test over")).code, 0);
  });

  it("marks runs abandoned on a second signal, so the next start settles them", async () => {
    await setSleeperPolicy();
    const id = await createTask("Interrupted");
    const worker = await startUntilRunning(id);
    worker.child.kill("SIGINT");
    await sleep(300);
    assert.equal(worker.child.exitCode, null, "the first signal waits for the run");
    worker.child.kill("SIGINT");
    assert.equal(await worker.exited, 130, worker.output());
    for (let i = 0; i < 50 && alive(worker.pid); i++) await sleep(100);
    assert.equal(alive(worker.pid), false, "a forced stop kills the run's process group");

    const runs = parseJson<{ taskId: string; outcome: string }[]>(
      await bob("worker", "runs", "--json"),
    );
    assert.ok(runs.some((r) => r.taskId === id && r.outcome === "abandoned"));
    assert.equal((await taskOf(id)).task.state, "in_progress", "nothing published yet");

    assert.equal((await bob("worker", "start", "--once")).code, 0);
    assert.equal((await taskOf(id)).task.state, "open");
    assert.equal((await alice("task", "update", "ops", id, "cancelled", "test over")).code, 0);
  });

  it("reports whether the worker starts at login", async () => {
    const status = parseJson<{ service: { installed: boolean; supervisor: string } }>(
      await bob("worker", "status", "--json"),
    );
    assert.equal(status.service.installed, false);
    assert.match((await bob("worker", "status")).stdout, /start at login/);
  });
});
