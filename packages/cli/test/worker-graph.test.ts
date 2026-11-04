import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * The worker on a task graph, end to end through the built binary and real
 * git: dependencies hold a step back, a capability routes free work here, a
 * structured result comes back as refs, and a parent rolls up.
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

interface Detail {
  task: { id: string; state: string; assignee?: string };
  events: { action: string; body: string; refs: string[]; needs: string }[];
}

let tmp: string;
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

async function create(text: string, title: string, ...flags: string[]): Promise<string> {
  const created = parseJson<{ task: { id: string } }>(
    await alice("task", "create", "ops", text, "--title", title, ...flags, "--json"),
  );
  return created.task.id;
}

async function show(id: string): Promise<Detail> {
  assert.equal((await alice("sync")).code, 0);
  return parseJson<Detail>(await alice("task", "show", "ops", id, "--json"));
}

/** Writes result.json from the environment, the way the prompt footer asks. */
const RESULT_RUNNER = [
  process.execPath,
  "-e",
  [
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{",
    "const first=s.split('\\n')[0];",
    "require('fs').writeFileSync(process.env.OGURI_RESULT_FILE, JSON.stringify({",
    "summary:'Structured: '+first, pr:'https://github.com/acme/app/pull/42', artifacts:['out/report.txt']}));",
    "console.log('raw stdout that should not be reported');});",
  ].join(""),
];

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-worker-graph-e2e-"));
  const remote = join(tmp, "transport.git");
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
  await writeFile(
    join(bobHome, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      "  concurrency: 2",
      "  timeoutMinutes: 1",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  runners:",
      `    result: ${JSON.stringify(RESULT_RUNNER)}`,
      "  trustedRequesters: [alice-claude]",
      "  capabilities: [gpu]",
      "",
    ].join("\n"),
  );
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri worker on a task graph, end to end", () => {
  it("runs a step only after its dependency completed, and reports structured results", async () => {
    const first = await create("Build the image.", "Build", "--target", "bob-claude");
    const second = await create(
      "Push the image.",
      "Push",
      "--target",
      "bob-claude",
      "--depends-on",
      first,
    );

    const pass = await bob("worker", "start", "--once");
    assert.equal(pass.code, 0, pass.stderr);
    assert.match(pass.stdout, new RegExp(`${second} not ready: waiting on ${first}`));
    assert.equal((await show(first)).task.state, "completed");
    assert.equal((await show(second)).task.state, "open");

    const next = await bob("worker", "start", "--once");
    assert.equal(next.code, 0, next.stderr);
    const detail = await show(second);
    assert.equal(detail.task.state, "completed");
    const done = detail.events.at(-1);
    assert.match(done?.body ?? "", /Structured: Push the image\./);
    assert.doesNotMatch(done?.body ?? "", /raw stdout/);
    assert.deepEqual(done?.refs, [
      "https://github.com/acme/app/pull/42",
      `artifact:${await machineId(bobHome)}:${join(tmp, "out", "report.txt")}`,
    ]);
  });

  it("takes free work that requires a capability it declares, and publishes the capability", async () => {
    const id = await create("Train the model.", "Train", "--requires", "gpu");
    const plain = await create("Anyone may tidy up.", "Tidy");
    const pass = await bob("worker", "start", "--once");
    assert.equal(pass.code, 0, pass.stderr);

    const detail = await show(id);
    assert.equal(detail.task.state, "completed");
    assert.equal(detail.task.assignee, "bob-claude");
    assert.equal((await show(plain)).task.state, "open", "plain free work is left to people");

    const profile = parseJson<{ capabilities: string[] }>(
      await alice("profile", "show", "bob-claude", "--json"),
    );
    assert.ok(profile.capabilities.includes("gpu"));
  });

  it("rolls a parent up once its subtasks completed", async () => {
    const parent = await create("Ship 2.0.", "Ship", "--target", "bob-claude");
    assert.equal((await bob("sync")).code, 0);
    assert.equal((await bob("task", "approve", "ops", parent)).code, 0);
    assert.equal((await bob("task", "claim", "ops", parent, "Coordinating the release.")).code, 0);

    const kid = await create("Write notes.", "Notes", "--parent", parent);
    assert.equal((await bob("sync")).code, 0);
    assert.equal((await bob("task", "approve", "ops", kid)).code, 0);
    assert.equal((await bob("task", "claim", "ops", kid, "Taking the notes.")).code, 0);
    const early = parseJson<{ action: string; reason: string }>(
      await bob("task", "rollup", "ops", parent, "--json"),
    );
    assert.equal(early.action, "none");
    assert.match(early.reason, /still in progress/);

    assert.equal((await bob("task", "update", "ops", kid, "started", "Writing.")).code, 0);
    assert.equal(
      (await bob("task", "update", "ops", kid, "completed", "Written.", "--ref", "branch:notes"))
        .code,
      0,
    );
    const rolled = await bob("task", "rollup", "ops", parent);
    assert.equal(rolled.code, 0, rolled.stderr);
    assert.match(rolled.stdout, /completed/);

    const detail = await show(parent);
    assert.equal(detail.task.state, "completed");
    const done = detail.events.at(-1);
    assert.match(done?.body ?? "", new RegExp(`${kid} Notes — branch:notes`));
    assert.deepEqual(done?.refs, ["branch:notes"]);
  });

  it("refuses a rollup without a task id", async () => {
    const result = await bob("task", "rollup", "ops");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /task rollup needs <room> <parent-task-id>/);
  });
});

async function machineId(home: string): Promise<string> {
  const machine = parseJson<{ id: string }>(await oguri(home, "machine", "--json"));
  return machine.id;
}
