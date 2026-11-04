import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * `oguri plan` end to end through the built binary and real git. The planner
 * model is a node one-liner that prints a fixed reply, so the test covers
 * everything except the model itself: prompt on stdin, JSON extraction,
 * validation, creation order, and the graph that results.
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
let home: string;

async function oguri(...args: string[]): Promise<Result> {
  const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function parseJson<T>(result: Result): T {
  assert.equal(
    result.code,
    0,
    `expected success, got ${String(result.code)}: ${result.stdout}${result.stderr}`,
  );
  return JSON.parse(result.stdout) as T;
}

const REPLY = {
  title: "Ship the report",
  tasks: [
    { key: "write", title: "Write it up", body: "Summarise.", dependsOn: ["data", "chart"] },
    { key: "data", title: "Collect data", body: "Pull the numbers." },
    {
      key: "chart",
      title: "Draw charts",
      body: "Plot them.",
      dependsOn: ["data"],
      requires: ["python"],
    },
  ],
};

/** A planner that proves it received the goal on stdin, then replies in a fence like a chatty model. */
function plannerArgv(reply: unknown): string[] {
  const script = [
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{",
    "if(!s.includes('<<<GOAL')||!s.includes('machine:'))process.exit(7);",
    `console.log('Here is the plan:\\n\`\`\`json\\n'+${JSON.stringify(JSON.stringify(reply))}+'\\n\`\`\`');});`,
  ].join("");
  return [process.execPath, "-e", script];
}

async function setPolicy(runnerArgv: string[]): Promise<void> {
  await writeFile(
    join(home, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: false",
      "  timeoutMinutes: 1",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  runners:",
      `    planner: ${JSON.stringify(runnerArgv)}`,
      "  plannerRunner: planner",
      "",
    ].join("\n"),
  );
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-plan-e2e-"));
  home = join(tmp, "home");
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  assert.equal(
    (await oguri("init", "--repo", remote, "--network", "acme", "--agent", "alice-claude")).code,
    0,
  );
  assert.equal((await oguri("room", "create", "ops", "--title", "Ops")).code, 0);
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri plan", () => {
  it("shows the plan and creates nothing on --dry-run", async () => {
    await setPolicy(plannerArgv(REPLY));
    const result = await oguri("plan", "ops", "Ship the weekly report", "--dry-run");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Ship the report/);
    assert.match(result.stdout, /dry run: nothing was created/);
    const listed = parseJson<unknown[]>(await oguri("task", "list", "ops", "--json"));
    assert.equal(listed.length, 0);
  });

  it("refuses to create without --yes when it cannot ask", async () => {
    await setPolicy(plannerArgv(REPLY));
    const result = await oguri("plan", "ops", "Ship the weekly report");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /not created/);
    assert.equal(parseJson<unknown[]>(await oguri("task", "list", "ops", "--json")).length, 0);
  });

  it("creates a parent and a dependency graph in order, with real ids", async () => {
    await setPolicy(plannerArgv(REPLY));
    const created = parseJson<{
      parent: { id: string };
      parentClaimed: boolean;
      tasks: { key: string; id: string }[];
    }>(await oguri("plan", "ops", "Ship the weekly report", "--yes", "--json"));

    assert.equal(created.parentClaimed, true);
    assert.deepEqual(
      created.tasks.map((t) => t.key),
      ["data", "chart", "write"],
      "dependencies are created before their dependents, whatever order the model wrote them",
    );
    const id = Object.fromEntries(created.tasks.map((t) => [t.key, t.id]));

    const detail = parseJson<{
      task: { dependsOn?: string[]; parent?: string; requires?: string[] };
    }>(await oguri("task", "show", "ops", id["write"] as string, "--json"));
    assert.equal(detail.task.parent, created.parent.id);
    assert.deepEqual([...(detail.task.dependsOn ?? [])].sort(), [id["data"], id["chart"]].sort());

    const chart = parseJson<{ task: { requires?: string[] } }>(
      await oguri("task", "show", "ops", id["chart"] as string, "--json"),
    );
    assert.deepEqual(chart.task.requires, ["python"]);

    const tree = await oguri("task", "tree", "ops", created.parent.id);
    assert.equal(tree.code, 0, tree.stdout + tree.stderr);
    for (const title of ["Collect data", "Draw charts", "Write it up"]) {
      assert.match(tree.stdout, new RegExp(title));
    }
  });

  it("says what is wrong with an invalid reply and creates nothing", async () => {
    const before = parseJson<unknown[]>(await oguri("task", "list", "ops", "--json")).length;
    const cyclic = {
      title: "Loop",
      tasks: [
        { key: "a", title: "A", body: "b", dependsOn: ["b"] },
        { key: "b", title: "B", body: "b", dependsOn: ["a"] },
      ],
    };
    await setPolicy(plannerArgv(cyclic));
    const result = await oguri("plan", "ops", "Do a loop", "--yes");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /the plan is not valid/);
    assert.match(result.stdout, /cycle among: a, b/);
    assert.equal(parseJson<unknown[]>(await oguri("task", "list", "ops", "--json")).length, before);
  });

  it("reports a planner that fails, instead of creating anything", async () => {
    await setPolicy([
      process.execPath,
      "-e",
      "console.error('model quota exhausted');process.exit(3)",
    ]);
    const result = await oguri("plan", "ops", "Anything", "--yes");
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /exited with 3.*model quota exhausted/s);
  });

  it("will not run a runner that is not on the allow-list", async () => {
    await setPolicy(plannerArgv(REPLY));
    const result = await oguri("plan", "ops", "Anything", "--runner", "rm-everything", "--dry-run");
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /not on this machine's allow-list/);
  });

  it("builds a plan from a file with no model call", async () => {
    // No runner at all: --from-file must not need one.
    await writeFile(join(home, "policy.yaml"), "v: 1\n");
    const file = join(tmp, "plan.json");
    await writeFile(
      file,
      JSON.stringify({
        title: "By hand",
        tasks: [{ key: "only", title: "Only step", body: "Do it." }],
      }),
    );
    const created = parseJson<{ tasks: { key: string }[] }>(
      await oguri("plan", "ops", "--from-file", file, "--yes", "--json"),
    );
    assert.deepEqual(
      created.tasks.map((t) => t.key),
      ["only"],
    );
  });

  it("refuses a plan file that holds a secret, naming where and not what", async () => {
    await writeFile(join(home, "policy.yaml"), "v: 1\n");
    const file = join(tmp, "secret-plan.json");
    await writeFile(
      file,
      JSON.stringify({
        title: "Leaky",
        tasks: [{ key: "a", title: "A", body: "key AKIAIOSFODNN7EXAMPLE" }],
      }),
    );
    const result = await oguri("plan", "ops", "--from-file", file, "--yes");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /possible secret/);
    assert.doesNotMatch(result.stdout, /AKIAIOSFODNN7EXAMPLE/);
  });
});
