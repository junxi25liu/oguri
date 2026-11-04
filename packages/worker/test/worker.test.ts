import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_WORKER_POLICY, type Agenda, type WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { RunBudget } from "../src/budget.ts";
import { runExecutor, type Executor, type RunResult } from "../src/runner.ts";
import { listRuns } from "../src/runs.ts";
import { parseRunnerHint, resolveRunner, selectCandidates } from "../src/select.ts";
import { SUMMARY_LIMIT, summarise } from "../src/summary.ts";
import { Worker } from "../src/worker.ts";

const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const ID_C = "01JCCCCCCCCCCCCCCCCCCCCCCC";

function policy(overrides: Partial<WorkerPolicy> = {}): WorkerPolicy {
  return {
    ...DEFAULT_WORKER_POLICY,
    enabled: true,
    runners: {
      claude: { argv: ["claude", "-p"], worktree: false },
      codex: { argv: ["codex", "exec", "-"], worktree: false },
    },
    trustedRequesters: [],
    ...overrides,
  };
}

interface FakeTask {
  id: string;
  relation?: string;
  state?: string;
  creator?: string;
  definition: string;
  ready?: boolean;
}

function agendaOf(tasks: FakeTask[]): Agenda {
  return {
    entries: tasks.map((t) => ({
      room: "ops",
      relation: t.relation ?? "offered",
      inFlight: false,
      needsAttention: false,
      ready: t.ready ?? true,
      status: {
        task: {
          id: t.id,
          title: `task ${t.id.slice(-3)}`,
          creator: t.creator ?? "alice-claude",
          state: t.state ?? "open",
        },
        definition: t.definition,
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

describe("runner hints", () => {
  it("reads a runner from the first line and strips it from the prompt", () => {
    assert.deepEqual(parseRunnerHint("runner: codex\nFix the build."), {
      runner: "codex",
      prompt: "Fix the build.",
    });
    assert.deepEqual(parseRunnerHint("Fix the build.\nrunner: codex"), {
      prompt: "Fix the build.\nrunner: codex",
    });
  });

  it("only maps a hint to an allow-listed argv", () => {
    assert.deepEqual(resolveRunner(policy(), "codex"), {
      name: "codex",
      argv: ["codex", "exec", "-"],
      worktree: false,
    });
    assert.deepEqual(resolveRunner(policy({ defaultRunner: "codex" }), undefined), {
      name: "codex",
      argv: ["codex", "exec", "-"],
      worktree: false,
    });
    const refused = resolveRunner(policy(), "bash");
    assert.ok("error" in refused);
    assert.match(refused.error, /not allowed here/);
  });

  it("uses a runner's model for both the first run and a resumed session", () => {
    assert.deepEqual(
      resolveRunner(
        policy({
          runners: {
            cheap: {
              argv: ["claude", "-p", "--output-format", "json"],
              model: "deepseek-v4.1-flash",
              resume: ["claude", "-p", "--output-format", "json", "--resume", "{session}"],
              session: "claude-json",
              worktree: false,
            },
            codex: {
              argv: ["codex", "exec", "-"],
              model: "gpt-5-codex",
              worktree: false,
            },
          },
        }),
        "cheap",
      ),
      {
        name: "cheap",
        argv: ["claude", "-p", "--output-format", "json", "--model", "deepseek-v4.1-flash"],
        worktree: false,
        resume: [
          "claude",
          "-p",
          "--output-format",
          "json",
          "--resume",
          "{session}",
          "--model",
          "deepseek-v4.1-flash",
        ],
        session: "claude-json",
      },
    );
    const plainCodex = resolveRunner(policy({ defaultRunner: "codex" }), "codex");
    assert.ok(!("error" in plainCodex));
    assert.deepEqual(plainCodex.argv, ["codex", "exec", "-"]);
    const selected = selectCandidates(
      agendaOf([{ id: ID_A, definition: "runner: codex\nFix the build." }]),
      policy({
        runners: {
          codex: { argv: ["codex", "exec", "-"], model: "gpt-5-codex", worktree: false },
        },
      }),
    );
    assert.deepEqual(selected.candidates[0]?.argv, ["codex", "exec", "-", "-m", "gpt-5-codex"]);
  });

  it("keeps a model the owner already put in the argv", () => {
    const resolved = resolveRunner(
      policy({
        runners: {
          claude: {
            argv: ["claude", "-p", "--model", "chosen-in-argv"],
            model: "deepseek-v4.1-flash",
            worktree: false,
          },
        },
      }),
      "claude",
    );
    assert.ok(!("error" in resolved));
    assert.deepEqual(resolved.argv, ["claude", "-p", "--model", "chosen-in-argv"]);
  });
});

describe("candidate selection", () => {
  it("takes only open tasks offered here, and explains the ones it skips", () => {
    const { candidates, skipped } = selectCandidates(
      agendaOf([
        { id: ID_A, definition: "Do the thing." },
        { id: ID_B, definition: "runner: bash\nrm -rf /" },
        { id: ID_C, relation: "unclaimed", definition: "Anyone?" },
        { id: "01JDDDDDDDDDDDDDDDDDDDDDDD", state: "claimed", definition: "Taken." },
      ]),
      policy(),
    );
    assert.deepEqual(
      candidates.map((c) => [c.taskId, c.runner, c.prompt]),
      [[ID_A, "claude", "Do the thing."]],
    );
    assert.deepEqual(
      skipped.map((s) => s.taskId),
      [ID_B],
    );
  });

  it("does not offer a task that is already running in this process", () => {
    const { candidates } = selectCandidates(
      agendaOf([{ id: ID_A, definition: "x" }]),
      policy(),
      new Set([ID_A]),
    );
    assert.equal(candidates.length, 0);
  });
});

describe("run budget", () => {
  it("enforces concurrency and a rolling hourly limit", () => {
    let now = 0;
    const budget = new RunBudget(
      () => ({ concurrency: 1, maxPerHour: 2 }),
      () => now,
    );
    assert.equal(budget.blocker(), null);
    budget.start();
    assert.match(budget.blocker() ?? "", /slot/);
    budget.finish();
    budget.start();
    budget.finish();
    assert.match(budget.blocker() ?? "", /hourly limit/);
    now = 60 * 60_000 + 1;
    assert.equal(budget.blocker(), null);
  });
});

describe("summaries", () => {
  const context = { runner: "claude", where: "bob:/tmp/runs/x", timeoutMinutes: 60 };

  it("keeps the end of long output within the limit", () => {
    const long = `${"line\n".repeat(5000)}FINAL ANSWER`;
    const body = summarise(result({ stdoutTail: long }), context);
    assert.ok(Buffer.byteLength(body) < SUMMARY_LIMIT + 512);
    assert.match(body, /Last part of the output/);
    assert.match(body, /FINAL ANSWER/);
  });

  it("withholds output the secret scanner flags", () => {
    const body = summarise(
      result({ stdoutTail: `token ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2).slice(0, 36)}` }),
      context,
    );
    assert.match(body, /Output withheld/);
    assert.doesNotMatch(body, /ghp_/);
  });

  it("names the failure", () => {
    assert.match(
      summarise(result({ timedOut: true, exitCode: null, signal: "SIGTERM" }), context),
      /exceeded its 60 minute limit/,
    );
    assert.match(summarise(result({ exitCode: 3 }), context), /exited with code 3/);
  });
});

describe("executor", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "oguri-runner-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes the prompt on stdin, never on the command line", async () => {
    const prompt = "$(touch pwned) `id` ; echo hi";
    const run = await runExecutor({
      argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      cwd: dir,
      prompt,
      timeoutMs: 10_000,
      logDir: join(dir, "a"),
    });
    assert.equal(run.exitCode, 0);
    assert.equal(run.stdoutTail, prompt);
    assert.equal(await readFile(join(dir, "a", "stdout.log"), "utf8"), prompt);
  });

  it("kills a run that exceeds its timeout", async () => {
    const run = await runExecutor({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      cwd: dir,
      prompt: "",
      timeoutMs: 200,
      logDir: join(dir, "b"),
    });
    assert.equal(run.timedOut, true);
  });

  it("reports a runner that does not exist", async () => {
    const run = await runExecutor({
      argv: ["oguri-no-such-runner"],
      cwd: dir,
      prompt: "",
      timeoutMs: 5_000,
      logDir: join(dir, "c"),
    });
    assert.ok(run.error !== undefined);
  });
});

/** A backend that records calls and answers from a script. */
function fakeBackend(
  agenda: Agenda,
  onCall: (method: string, params: Record<string, unknown>) => unknown,
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const backend: Backend = {
    mode: "direct",
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      if (method === "agenda") return agenda as T;
      return (await onCall(method, params)) as T;
    },
    async networks() {
      return [];
    },
    async close() {},
  };
  return { backend, calls };
}

describe("worker pass", () => {
  let home: string;
  before(async () => {
    home = await mkdtemp(join(tmpdir(), "oguri-worker-"));
  });
  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const okExecutor: Executor = async () => result({ stdoutTail: "patched 3 files" });

  it("does nothing while disabled", async () => {
    const { backend, calls } = fakeBackend(agendaOf([{ id: ID_A, definition: "x" }]), () => ({}));
    const worker = new Worker({
      backend,
      agentId: "bob-claude",
      home,
      loadPolicy: async () => policy({ enabled: false }),
      executor: okExecutor,
    });
    const report = await worker.pass();
    assert.equal(report.enabled, false);
    assert.deepEqual(calls, []);
  });

  it("posts the run's report as a note when the worker completed its own task", async () => {
    let completedByWorker = false;
    const { backend, calls } = fakeBackend(
      agendaOf([
        { id: "01JSSSSSSSSSSSSSSSSSSSSSSS", definition: "Fix it.", creator: "alice-claude" },
      ]),
      (method, params) => {
        const action = (params["input"] as { action?: string } | undefined)?.action;
        // The worker's own oguri_task call ended the task during the run.
        if (method === "taskUpdate" && action === "completed" && completedByWorker) {
          throw new Error("a task completes only from in-progress");
        }
        if (method === "taskShow" && completedByWorker) {
          return { task: { state: "completed" }, children: [] };
        }
        return {};
      },
    );
    const worker = new Worker({
      backend,
      agentId: "bob-claude",
      home,
      loadPolicy: async () => policy({ trustedRequesters: ["alice-claude"] }),
      executor: async () => {
        completedByWorker = true;
        return result({ stdoutTail: "patched 3 files" });
      },
    });
    await worker.pass();
    await worker.idle();
    const methods = calls.map((c) =>
      c.method === "taskUpdate"
        ? `taskUpdate:${(c.params["input"] as { action: string }).action}`
        : c.method,
    );
    assert.ok(!methods.includes("taskUpdate:blocked"), "it is not reported as blocked");
    const note = calls.findLast((c) => c.method === "send");
    assert.ok(note !== undefined, "the run's report is posted in the thread");
    const body = (note.params["input"] as { body: string }).body;
    assert.match(body, /patched 3 files/);
    assert.match(body, /marked this task completed itself/);
  });

  it("approves a trusted requester, claims, runs, and completes", async () => {
    const { backend, calls } = fakeBackend(
      agendaOf([{ id: ID_A, definition: "Fix it.", creator: "alice-claude" }]),
      () => ({}),
    );
    const seen: string[] = [];
    const worker = new Worker({
      backend,
      agentId: "bob-claude",
      home,
      loadPolicy: async () => policy({ trustedRequesters: ["alice-claude"] }),
      executor: async (request) => {
        seen.push(request.prompt);
        return result({ stdoutTail: "patched 3 files" });
      },
    });
    const report = await worker.pass();
    await worker.idle();
    assert.deepEqual(report.started, [ID_A]);
    assert.equal(seen.length, 1);
    // The task text first, then the footer offering result.json.
    assert.ok(seen[0]?.startsWith("Fix it.\n\n---\n"), seen[0]);
    assert.match(seen[0] ?? "", /OGURI_RESULT_FILE/);

    const sequence = calls.map((c) =>
      c.method === "taskUpdate"
        ? `taskUpdate:${(c.params["input"] as { action: string }).action}`
        : c.method,
    );
    assert.deepEqual(sequence, [
      "sync",
      "agenda",
      "approve",
      "taskClaim",
      "taskUpdate:started",
      // After the run: did it split the task into subtasks that are still open?
      "taskShow",
      "taskUpdate:completed",
    ]);
    const done = calls.at(-1)?.params["input"] as { body: string };
    assert.match(done.body, /patched 3 files/);

    const [run] = await listRuns(home);
    assert.equal(run?.outcome, "completed");
  });

  it("leaves an untrusted remote task for a person to approve", async () => {
    const { backend, calls } = fakeBackend(
      agendaOf([{ id: ID_B, definition: "Deploy.", creator: "mallory-codex" }]),
      (method) => {
        if (method === "taskClaim") {
          throw Object.assign(new Error("needs approval"), { code: "APPROVAL_REQUIRED" });
        }
        return {};
      },
    );
    let ran = false;
    const worker = new Worker({
      backend,
      agentId: "bob-claude",
      home,
      loadPolicy: async () => policy({ trustedRequesters: ["alice-claude"] }),
      executor: async () => {
        ran = true;
        return result();
      },
    });
    const report = await worker.pass();
    await worker.idle();
    assert.equal(ran, false);
    assert.deepEqual(report.started, []);
    assert.match(report.skipped[0]?.reason ?? "", /awaiting approval/);
    assert.ok(!calls.some((c) => c.method === "approve"));
  });

  it("blocks the task when the run fails", async () => {
    const { backend, calls } = fakeBackend(
      agendaOf([{ id: ID_C, definition: "Try." }]),
      () => ({}),
    );
    const worker = new Worker({
      backend,
      agentId: "bob-claude",
      home,
      loadPolicy: async () => policy(),
      executor: async () => result({ exitCode: 2, stdoutTail: "error: tests failed" }),
    });
    await worker.pass();
    await worker.idle();
    const last = calls.at(-1)?.params["input"] as { action: string; body: string };
    assert.equal(last.action, "blocked");
    assert.match(last.body, /exited with code 2/);
  });
});
