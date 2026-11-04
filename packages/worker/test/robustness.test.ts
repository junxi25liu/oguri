import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";

import { DEFAULT_WORKER_POLICY, type Agenda, type WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { abandonAction, stopReason } from "../src/lifecycle.ts";
import { pidExists } from "../src/process.ts";
import { runExecutor, type Executor, type RunRequest, type RunResult } from "../src/runner.ts";
import { listRuns, runDir, writeRunRecord, type RunRecord } from "../src/runs.ts";
import { Worker } from "../src/worker.ts";

const exec = promisify(execFile);

const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const ID_C = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const ME = "bob-claude";

function policy(overrides: Partial<WorkerPolicy> = {}): WorkerPolicy {
  return {
    ...DEFAULT_WORKER_POLICY,
    enabled: true,
    runners: { claude: { argv: ["claude", "-p"], worktree: false } },
    trustedRequesters: [],
    ...overrides,
  };
}

function agendaOf(ids: string[]): Agenda {
  return {
    entries: ids.map((id) => ({
      room: "ops",
      relation: "offered",
      inFlight: false,
      needsAttention: false,
      ready: true,
      status: {
        task: { id, title: `task ${id.slice(-3)}`, creator: "alice-claude", state: "open" },
        definition: "Do the thing.",
        waitingOn: [],
        children: [],
      },
    })),
    counts: {},
    inFlightThreads: [],
  } as unknown as Agenda;
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1200,
    stdoutTail: "all done",
    ...overrides,
  };
}

interface TaskView {
  state: string;
  assignee?: string;
}

/**
 * A backend whose tasks have a state that tests can change, and that records
 * every call. `taskShow` answers from that state, as the real one would.
 */
function fakeBackend(agenda: Agenda, tasks: Map<string, TaskView> = new Map()) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const backend: Backend = {
    mode: "direct",
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      if (method === "agenda") return agenda as T;
      if (method === "taskShow") {
        const id = params["taskId"] as string;
        const view = tasks.get(id) ?? { state: "in_progress", assignee: ME };
        return {
          task: {
            id,
            title: "t",
            creator: "alice-claude",
            action: "progressed",
            staleAfterSeconds: 86400,
            ...view,
          },
          events: [],
        } as T;
      }
      return {} as T;
    },
    async networks() {
      return [];
    },
    async close() {},
  };
  const updates = () =>
    calls
      .filter((c) => c.method === "taskUpdate")
      .map(
        (c) =>
          ({ taskId: c.params["taskId"], ...(c.params["input"] as object) }) as {
            taskId: string;
            action: string;
            body: string;
          },
      );
  return { backend, calls, updates };
}

/** A pid that certainly belonged to a process and certainly no longer does. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid as number;
}

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

/** An executor that runs until it is aborted, as a real run stopped by a signal would. */
const untilAborted: Executor = async (request) =>
  await new Promise<RunResult>((resolve) => {
    const stop = (): void =>
      resolve(result({ exitCode: null, signal: "SIGTERM", aborted: true, stdoutTail: "" }));
    if (request.signal?.aborted === true) stop();
    else request.signal?.addEventListener("abort", stop, { once: true });
  });

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-worker-robust-"));
});

describe("lifecycle rules", () => {
  const task = (state: string, assignee?: string) =>
    ({
      id: ID_A,
      state,
      action: "progressed",
      creator: "alice-claude",
      title: "t",
      staleAfterSeconds: 86400,
      ...(assignee === undefined ? {} : { assignee }),
    }) as Parameters<typeof stopReason>[0];

  it("stops a run whose task was cancelled, released, or reassigned", () => {
    assert.equal(stopReason(task("in_progress", ME), ME), null);
    assert.match(stopReason(task("cancelled", ME), ME) ?? "", /cancelled/);
    assert.match(stopReason(task("open"), ME) ?? "", /released/);
    assert.match(stopReason(task("claimed", "carol-codex"), ME) ?? "", /reassigned to carol-codex/);
  });

  it("settles only a task this agent still holds and has not finished", () => {
    assert.equal(abandonAction(task("in_progress", ME), ME, "release"), "released");
    assert.equal(abandonAction(task("in_progress", ME), ME, "block"), "blocked");
    assert.equal(abandonAction(task("stuck", ME), ME, "release"), "released");
    assert.equal(abandonAction(task("stuck", ME), ME, "block"), null, "already waiting");
    assert.equal(abandonAction(task("completed", ME), ME, "release"), null);
    assert.equal(abandonAction(task("cancelled", ME), ME, "release"), null);
    assert.equal(abandonAction(task("in_progress", "carol-codex"), ME, "release"), null);
    assert.equal(abandonAction(task("open"), ME, "release"), null);
  });
});

describe("crash recovery", () => {
  function running(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      taskId: ID_A,
      runId: "01JRUN0000000000000000000A",
      room: "ops",
      title: "task AAA",
      runner: "claude",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      outcome: "running",
      ...overrides,
    };
  }

  it("releases the task of a run whose worker died, and never reruns it in that pass", async () => {
    await writeRunRecord(home, running({ workerPid: await deadPid(), pid: await deadPid() }));
    const { backend, updates } = fakeBackend(agendaOf([ID_A]));
    let ran = false;
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
      executor: async () => {
        ran = true;
        return result();
      },
    });
    const report = await worker.pass();
    await worker.idle();

    assert.deepEqual(report.recovered, [
      { taskId: ID_A, runId: "01JRUN0000000000000000000A", published: "released" },
    ]);
    assert.deepEqual(
      updates().map((u) => [u.taskId, u.action]),
      [[ID_A, "released"]],
    );
    assert.match(updates()[0]?.body ?? "", /cut off/);
    assert.equal(ran, false, "the machine that crashed must not take the task straight back");
    assert.deepEqual(report.started, []);

    const [record] = await listRuns(home);
    assert.equal(record?.outcome, "abandoned");
    assert.ok(record?.reconciledAt !== undefined);
  });

  it("blocks instead when worker.onAbandon is block", async () => {
    await writeRunRecord(home, running({ workerPid: await deadPid() }));
    const { backend, updates } = fakeBackend(agendaOf([]));
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ onAbandon: "block" }),
    });
    await worker.pass();
    assert.deepEqual(
      updates().map((u) => u.action),
      ["blocked"],
    );
  });

  it("treats a record with no pid as gone, including the old per-task layout", async () => {
    const legacy = running({ taskId: ID_B });
    delete legacy.runId;
    await mkdir(runDir(home, ID_B), { recursive: true });
    await writeFile(join(runDir(home, ID_B), "run.json"), JSON.stringify(legacy));

    const { backend, updates } = fakeBackend(agendaOf([]));
    const worker = new Worker({ backend, agentId: ME, home, loadPolicy: async () => policy() });
    await worker.pass();

    assert.deepEqual(
      updates().map((u) => [u.taskId, u.action]),
      [[ID_B, "released"]],
    );
    const record = JSON.parse(await readFile(join(runDir(home, ID_B), "run.json"), "utf8"));
    assert.equal(record.outcome, "abandoned");
  });

  it("leaves a task alone that finished or moved on while the worker was down", async () => {
    await writeRunRecord(home, running({ taskId: ID_A }));
    await writeRunRecord(home, running({ taskId: ID_B, runId: "01JRUN0000000000000000000B" }));
    const { backend, updates } = fakeBackend(
      agendaOf([]),
      new Map([
        [ID_A, { state: "completed", assignee: ME }],
        [ID_B, { state: "claimed", assignee: "carol-codex" }],
      ]),
    );
    const worker = new Worker({ backend, agentId: ME, home, loadPolicy: async () => policy() });
    const report = await worker.pass();
    assert.deepEqual(updates(), []);
    assert.equal(report.recovered?.length, 2);
    assert.ok(report.recovered?.every((r) => r.published === null));
    assert.ok((await listRuns(home)).every((r) => r.outcome === "abandoned"));
  });

  it("does not touch a run whose worker is still alive", async () => {
    await writeRunRecord(
      home,
      running({ workerPid: process.pid, startedAt: new Date().toISOString() }),
    );
    const { backend, updates } = fakeBackend(agendaOf([]));
    const worker = new Worker({ backend, agentId: ME, home, loadPolicy: async () => policy() });
    const report = await worker.pass();
    assert.equal(report.recovered, undefined);
    assert.deepEqual(updates(), []);
    assert.equal((await listRuns(home))[0]?.outcome, "running");
  });

  it("does not mistake a reused pid for the worker that wrote the record", async () => {
    // This process is alive, but it started after the record did, so it cannot
    // be the worker that wrote it — as after a reboot hands the pid to another.
    await writeRunRecord(
      home,
      running({
        workerPid: process.pid,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
    const { backend, updates } = fakeBackend(agendaOf([]));
    const worker = new Worker({ backend, agentId: ME, home, loadPolicy: async () => policy() });
    await worker.pass();
    assert.deepEqual(
      updates().map((u) => u.action),
      ["released"],
    );
  });

  it("kills an executor that outlived its worker", async () => {
    const orphan = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    orphan.unref();
    const pid = orphan.pid as number;
    try {
      await writeRunRecord(
        home,
        running({ workerPid: await deadPid(), pid, spawnedAt: new Date().toISOString() }),
      );
      const { backend } = fakeBackend(agendaOf([]));
      const worker = new Worker({ backend, agentId: ME, home, loadPolicy: async () => policy() });
      await worker.pass();
      await waitFor(() => !pidExists(pid));
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the point.
      }
    }
  });

  it("tries again on the next start when settling the task fails", async () => {
    await writeRunRecord(home, running({ workerPid: await deadPid() }));
    const { backend } = fakeBackend(agendaOf([]));
    const failing: Backend = {
      ...backend,
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        if (method === "taskShow") throw new Error("offline");
        return await backend.call<T>(method, params);
      },
    };
    const first = new Worker({
      backend: failing,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
    });
    await first.pass();
    assert.equal((await listRuns(home))[0]?.reconciledAt, undefined);

    const { backend: healthy, updates } = fakeBackend(agendaOf([]));
    const second = new Worker({
      backend: healthy,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
    });
    await second.pass();
    assert.deepEqual(
      updates().map((u) => u.action),
      ["released"],
    );
  });
});

describe("cancellation", () => {
  it("stops a run whose task is cancelled, and publishes nothing for it", async () => {
    const tasks = new Map<string, TaskView>([[ID_A, { state: "in_progress", assignee: ME }]]);
    const { backend, updates } = fakeBackend(agendaOf([ID_A]), tasks);
    let started: RunRequest | undefined;
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
      checkIntervalMs: 20,
      executor: async (request) => {
        started = request;
        return await untilAborted(request);
      },
    });
    await worker.pass();
    await waitFor(() => started !== undefined);
    tasks.set(ID_A, { state: "cancelled", assignee: ME });
    await worker.idle();

    assert.equal(started?.signal?.aborted, true);
    assert.deepEqual(
      updates().map((u) => u.action),
      ["started"],
      "no completion and no block for work the creator withdrew",
    );
    const [record] = await listRuns(home);
    assert.equal(record?.outcome, "cancelled");
    assert.match(record?.note ?? "", /cancelled/);
  });

  it("stops a run whose task was reassigned, at the next pass", async () => {
    const tasks = new Map<string, TaskView>([[ID_A, { state: "in_progress", assignee: ME }]]);
    const { backend, updates } = fakeBackend(agendaOf([ID_A]), tasks);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy(),
      // Far away: this test proves the pass checks too, not only the timer.
      checkIntervalMs: 60_000,
      executor: async (request) => {
        executing = true;
        return await untilAborted(request);
      },
    });
    let executing = false;
    await worker.pass();
    await waitFor(() => executing);
    tasks.set(ID_A, { state: "claimed", assignee: "carol-codex" });
    await worker.pass();
    await worker.idle();

    assert.deepEqual(
      updates().map((u) => u.action),
      ["started"],
    );
    const [record] = await listRuns(home);
    assert.equal(record?.outcome, "cancelled");
    assert.match(record?.note ?? "", /reassigned to carol-codex/);
  });
});

describe("process groups", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "oguri-pgroup-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A runner that starts a grandchild and writes its pid down. The grandchild
   * does not hold the output pipes, so the run "ends" as soon as `sh` dies —
   * which is exactly how a stray process outlives a run nobody is watching.
   */
  function grandparent(pidFile: string): string[] {
    return ["sh", "-c", 'sleep 60 >/dev/null 2>&1 & echo $! > "$1"; wait', "sh", pidFile];
  }

  async function grandchildOf(pidFile: string): Promise<number> {
    const read = (): number => {
      try {
        return Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      } catch {
        return Number.NaN;
      }
    };
    await waitFor(() => read() > 0);
    return read();
  }

  async function assertGone(pid: number): Promise<void> {
    try {
      await waitFor(() => !pidExists(pid), 3_000);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  }

  it("kills the grandchildren of a run that times out", async () => {
    const pidFile = join(dir, "timeout.pid");
    const run = await runExecutor({
      argv: grandparent(pidFile),
      cwd: dir,
      prompt: "",
      timeoutMs: 500,
      logDir: join(dir, "timeout"),
    });
    assert.equal(run.timedOut, true);
    await assertGone(await grandchildOf(pidFile));
  });

  it("kills the grandchildren of a run that is aborted", async () => {
    const pidFile = join(dir, "abort.pid");
    const controller = new AbortController();
    let spawned = 0;
    const pending = runExecutor({
      argv: grandparent(pidFile),
      cwd: dir,
      prompt: "",
      timeoutMs: 60_000,
      logDir: join(dir, "abort"),
      signal: controller.signal,
      onSpawn: (pid) => {
        spawned = pid;
      },
    });
    const grandchild = await grandchildOf(pidFile);
    controller.abort();
    const run = await pending;
    assert.equal(run.aborted, true);
    assert.equal(run.timedOut, false);
    assert.ok(spawned > 0, "the caller learns the pid, so a record can hold it");
    await assertGone(grandchild);
  });

  it("abandons in-flight runs on a forced stop and kills their process groups", async () => {
    const pidFile = join(dir, "abandon.pid");
    const { backend, updates } = fakeBackend(agendaOf([ID_C]));
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({
          runners: { claude: { argv: grandparent(pidFile), worktree: false } },
          workdir: dir,
        }),
    });
    await worker.pass();
    const grandchild = await grandchildOf(pidFile);
    await waitFor(() => worker.running === 1);
    await worker.abandon();
    await worker.idle();

    await assertGone(grandchild);
    const [record] = await listRuns(home);
    assert.equal(record?.outcome, "abandoned");
    assert.equal(record?.workerPid, process.pid);
    assert.ok(record?.pid !== undefined);
    assert.deepEqual(
      updates().map((u) => u.action),
      ["started"],
      "a forced stop publishes nothing; the next start settles the task",
    );
  });
});

describe("hourly budget across restarts", () => {
  it("counts runs recorded in the last hour before starting any", async () => {
    const now = Date.now();
    for (const [i, minutesAgo] of [10, 50, 90].entries()) {
      await writeRunRecord(home, {
        taskId: [ID_A, ID_B, ID_C][i] as string,
        runId: `01JRUN000000000000000000${String(i)}A`,
        room: "ops",
        title: "t",
        runner: "claude",
        startedAt: new Date(now - minutesAgo * 60_000).toISOString(),
        outcome: "completed",
      });
    }
    const { backend } = fakeBackend(agendaOf(["01JDDDDDDDDDDDDDDDDDDDDDDD"]));
    let ran = false;
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ maxPerHour: 2 }),
      executor: async () => {
        ran = true;
        return result();
      },
    });
    const report = await worker.pass();
    assert.equal(ran, false);
    assert.match(report.limited ?? "", /hourly limit of 2/);
    assert.equal(worker.startedThisHour, 2, "the run 90 minutes ago no longer counts");
  });
});

describe("per-run directories", () => {
  it("keeps the logs of every run of a task and points OGURI_RUN_DIR at the run", async () => {
    const { backend } = fakeBackend(agendaOf([ID_A]));
    const dirs: string[] = [];
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ workdir: home }),
      executor: async (request) => {
        dirs.push(request.env?.["OGURI_RUN_DIR"] as string);
        await mkdir(request.logDir, { recursive: true });
        await writeFile(join(request.logDir, "stdout.log"), `run ${String(dirs.length)}`);
        assert.equal(request.logDir, request.env?.["OGURI_RUN_DIR"]);
        return result();
      },
    });
    // The same task run twice, as after a reopen.
    await worker.pass();
    await worker.idle();
    await worker.pass();
    await worker.idle();

    assert.equal(new Set(dirs).size, 2);
    const runs = await readdir(runDir(home, ID_A));
    assert.equal(runs.length, 2);
    for (const [i, path] of dirs.entries()) {
      assert.equal(await readFile(join(path, "stdout.log"), "utf8"), `run ${String(i + 1)}`);
    }
    const records = await listRuns(home);
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.runId !== undefined && r.outcome === "completed"));
  });

  it("still lists records written in the old per-task layout", async () => {
    await mkdir(runDir(home, ID_B), { recursive: true });
    await writeFile(
      join(runDir(home, ID_B), "run.json"),
      JSON.stringify({
        taskId: ID_B,
        room: "ops",
        title: "old",
        runner: "claude",
        startedAt: "2026-01-01T00:00:00.000Z",
        outcome: "completed",
      }),
    );
    await writeRunRecord(home, {
      taskId: ID_B,
      runId: "01JRUN0000000000000000000N",
      room: "ops",
      title: "new",
      runner: "claude",
      startedAt: "2026-02-01T00:00:00.000Z",
      outcome: "blocked",
    });
    const records = await listRuns(home);
    assert.deepEqual(
      records.map((r) => r.title),
      ["new", "old"],
    );
  });
});

describe("workspace isolation", () => {
  let repo: string;
  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "oguri-worker-repo-"));
    const git = (...args: string[]) =>
      exec("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args]);
    await git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(repo, "README"), "hello\n");
    await git("add", "README");
    await git("commit", "--quiet", "-m", "init");
  });
  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("runs each task in its own worktree and names the branch in the result", async () => {
    const { backend, calls, updates } = fakeBackend(agendaOf([ID_A, ID_B]));
    const cwds: string[] = [];
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({
          concurrency: 2,
          runners: { claude: { argv: ["claude"], workdir: repo, worktree: true } },
        }),
      executor: async (request) => {
        cwds.push(request.cwd);
        assert.equal(await readFile(join(request.cwd, "README"), "utf8"), "hello\n");
        await writeFile(join(request.cwd, "edit"), request.cwd);
        return result();
      },
    });
    await worker.pass();
    await worker.idle();

    assert.equal(new Set(cwds).size, 2, "concurrent runs must not share a checkout");
    const records = await listRuns(home);
    for (const record of records) {
      assert.equal(record.worktree?.path, join(runDir(home, record.taskId, record.runId), "work"));
      assert.equal(record.worktree?.branch, `oguri/${record.taskId}-${record.runId as string}`);
      assert.equal(record.cwd, record.worktree?.path);
      // Left in place for a person to read.
      assert.equal(await readFile(join(record.worktree.path, "edit"), "utf8"), record.cwd);
      const { stdout } = await exec("git", [
        "-C",
        record.worktree.path,
        "branch",
        "--show-current",
      ]);
      assert.equal(stdout.trim(), record.worktree.branch);
    }
    const done = updates().filter((u) => u.action === "completed");
    assert.equal(done.length, 2);
    for (const update of done) assert.match(update.body, /Work is on branch oguri\//);
    // The run's branch travels as a ref, so a reader can find the work without parsing prose.
    const branches = calls
      .filter((c) => c.method === "taskUpdate")
      .map((c) => c.params["input"] as { action: string; refs?: string[] })
      .filter((input) => input.action === "completed")
      .map((input) => input.refs);
    assert.deepEqual(
      branches.map((refs) => refs?.length === 1 && refs[0]?.startsWith("branch:oguri/")),
      [true, true],
    );
  });

  it("blocks the task when the runner's workdir is not a repository", async () => {
    const { backend, updates } = fakeBackend(agendaOf([ID_C]));
    let ran = false;
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({ runners: { claude: { argv: ["claude"], workdir: home, worktree: true } } }),
      executor: async () => {
        ran = true;
        return result();
      },
    });
    await worker.pass();
    await worker.idle();
    assert.equal(ran, false);
    assert.deepEqual(
      updates().map((u) => u.action),
      ["blocked"],
    );
    assert.match(updates()[0]?.body ?? "", /not a git repository/);
    assert.equal((await listRuns(home))[0]?.outcome, "blocked");
  });

  it("uses the runner's workdir over worker.workdir", async () => {
    const { backend } = fakeBackend(agendaOf([ID_A]));
    let cwd = "";
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () =>
        policy({
          workdir: home,
          runners: { claude: { argv: ["claude"], workdir: repo, worktree: false } },
        }),
      executor: async (request) => {
        cwd = request.cwd;
        return result();
      },
    });
    await worker.pass();
    await worker.idle();
    assert.equal(cwd, repo);
  });
});
