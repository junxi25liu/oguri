import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, it } from "node:test";

import { testEnv } from "./env.ts";

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
let tmp: string;
let home: string;
const env = () => testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
const cli = (...args: string[]) =>
  exec(process.execPath, [CLI, ...args, "--direct"], { env: env() });
const policy = (small: boolean, maxWorkers = 20, runner = "echo") =>
  [
    "v: 1",
    "worker:",
    "  enabled: true",
    "  concurrency: 1",
    "  runners:",
    `    ${runner}: [${JSON.stringify(process.execPath)}, -e, 'console.log("ok")']`,
    "superagent:",
    "  small:",
    `    enabled: ${String(small)}`,
    `    maxWorkers: ${String(maxWorkers)}`,
    "",
  ].join("\n");

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-acceptance-display-"));
  home = join(tmp, "home");
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await cli("init", "--repo", remote, "--network", "acme", "--agent", "display-test");
  await cli("room", "create", "ops");
});
after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("policy displays effective concurrency and its source with Small on or off", async () => {
  await writeFile(join(home, "policy.yaml"), policy(true));
  assert.match(
    (await cli("policy")).stdout,
    /20 at once.*superagent\.small\.maxWorkers.*worker\.concurrency is 1/,
  );
  await writeFile(join(home, "policy.yaml"), policy(false));
  assert.match((await cli("policy")).stdout, /1 at once.*worker\.concurrency/);
});

it("dashboard rereads policy and reports read errors instead of stale values", async () => {
  await writeFile(join(home, "policy.yaml"), policy(true));
  const server = spawn(process.execPath, [CLI, "web", "--port", "0", "--direct"], {
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`no URL: ${output}`)), 20_000);
      server.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(output);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`web exited: ${output}`));
      });
    });
    const dashboard = async () => {
      // The aggregate has an existing two-second cache; policy refreshes
      // within that short interval without restarting the server.
      await sleep(2_100);
      const res = await fetch(`${url}api/dashboard`);
      assert.equal(res.status, 200);
      return (await res.json()) as {
        overview: {
          local: {
            maxConcurrent: number | null;
            concurrencySource: string | null;
            workerConcurrency: number | null;
            smallMaxWorkers: number | null;
            runners: string[];
          };
        };
        errors: string[];
      };
    };
    const initial = await dashboard();
    assert.deepEqual(initial.overview.local.runners, ["echo"]);
    await writeFile(join(home, "policy.yaml"), policy(true, 12, "new-runner"));
    const changed = await dashboard();
    assert.deepEqual(changed.overview.local.runners, ["new-runner"]);
    assert.equal(changed.overview.local.maxConcurrent, 12);
    assert.equal(changed.overview.local.smallMaxWorkers, 12);
    assert.equal(initial.overview.local.maxConcurrent, 20);
    assert.equal(initial.overview.local.concurrencySource, "superagent.small.maxWorkers");
    assert.equal(initial.overview.local.workerConcurrency, 1);
    await writeFile(join(home, "policy.yaml"), policy(false));
    const disabled = await dashboard();
    assert.equal(disabled.overview.local.maxConcurrent, 1);
    assert.equal(disabled.overview.local.concurrencySource, "worker.concurrency");
    await writeFile(join(home, "policy.yaml"), "worker: [invalid\n");
    const broken = await dashboard();
    assert.equal(broken.overview.local.maxConcurrent, null);
    assert.deepEqual(broken.overview.local.runners, []);
    assert.ok(
      broken.errors.some((error) => error.includes("local policy")),
      broken.errors.join("\n"),
    );
  } finally {
    server.kill("SIGTERM");
    await exited;
  }
});

it("idle worker --once does not claim all slots are busy", async () => {
  await writeFile(join(home, "policy.yaml"), policy(false));
  const requesterHome = join(tmp, "requester");
  const requester = (...args: string[]) =>
    exec(process.execPath, [CLI, ...args, "--direct"], {
      env: testEnv({ OGURI_HOME: requesterHome, NO_COLOR: "1" }),
    });
  await requester(
    "init",
    "--repo",
    join(tmp, "transport.git"),
    "--network",
    "acme",
    "--agent",
    "requester-test",
  );
  await requester("room", "join", "ops");
  await writeFile(
    join(home, "policy.yaml"),
    policy(false).replace(
      "  concurrency: 1",
      "  concurrency: 1\n  trustedRequesters: [requester-test]",
    ),
  );
  await requester(
    "task",
    "create",
    "ops",
    "Say ok.",
    "--title",
    "Idle start",
    "--target",
    "display-test",
  );
  const result = await cli("worker", "start", "--once");
  assert.match(result.stdout, /running/);
  assert.doesNotMatch(result.stdout, /all .*run slot\(s\) are busy/);

  // The acceptance script queued six tasks before --once. Capacity is
  // genuinely full when the pass reaches the second candidate, even though
  // the first executor's asynchronous "running" log can appear later.
  await writeFile(
    join(home, "policy.yaml"),
    policy(false)
      .replace("  concurrency: 1", "  concurrency: 1\n  trustedRequesters: [requester-test]")
      .replace('console.log("ok")', 'setTimeout(() => console.log("ok"), 1000)'),
  );
  for (const title of ["First queued", "Second queued"]) {
    await requester(
      "task",
      "create",
      "ops",
      "Say ok.",
      "--title",
      title,
      "--target",
      "display-test",
    );
  }
  const queued = await cli("worker", "start", "--once");
  assert.match(queued.stdout, /all 1 run slot\(s\) are busy/);
  const runs = JSON.parse((await cli("worker", "runs", "--json")).stdout) as { outcome: string }[];
  assert.equal(
    runs.filter((run) => run.outcome === "completed").length,
    2,
    "the idle task and just one queued task ran; --once does not drain the backlog",
  );
});

it("worker runs shows request, CLI init, response source, usage labels and unknown", async () => {
  const records = [
    { taskId: "init", modelRequested: "request-A", modelInitialized: "init-B" },
    { taskId: "usage", modelsUsage: ["u1", "u2"] },
    {
      taskId: "response",
      modelRequested: "request-A",
      modelInitialized: "init-B",
      modelReported: "response-C",
      modelSource: "assistant-message",
      modelsUsage: ["u1"],
    },
    { taskId: "unknown" },
    { taskId: "legacy", modelReported: "old-label" },
  ];
  for (const record of records) {
    const dir = join(home, "runs", record.taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "run.json"),
      JSON.stringify({
        runId: record.taskId,
        room: "ops",
        title: record.taskId,
        runner: "echo",
        startedAt: new Date().toISOString(),
        outcome: "completed",
        ...record,
      }),
    );
  }
  const output = (await cli("worker", "runs")).stdout;
  assert.match(output, /request-A \(requested; service reported none\)/);
  assert.match(output, /init-B \(CLI init only; response model unknown\)/);
  assert.match(output, /response-C \(assistant message label; assistant-message\)/);
  assert.match(output, /init-B \(CLI init\)/);
  assert.match(output, /u1, u2 \(usage labels; no single answering model established\)/);
  assert.match(output, /model unknown/);
  assert.match(output, /old-label \(legacy label; source unverified\)/);
});
