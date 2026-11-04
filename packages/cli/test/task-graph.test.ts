import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

import { Layout } from "@oguri/core";
import { Daemon } from "@oguri/daemon";

/**
 * The task graph through the built CLI: flags, rendering, `task tree`, and the
 * create fields surviving the trip through a running daemon.
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
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const alice = (...args: string[]) => oguri(aliceHome, ...args);
const bob = (...args: string[]) => oguri(bobHome, ...args, "--direct");

function parseJson<T>(result: Result): T {
  assert.equal(result.code, 0, `expected success, got ${String(result.code)}: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

interface CreatedTask {
  task: {
    id: string;
    dependsOn?: string[];
    parent?: string;
    requires?: string[];
    maxAttempts?: number;
  };
}

async function create(title: string, ...flags: string[]): Promise<CreatedTask["task"]> {
  return parseJson<CreatedTask>(
    await alice(
      "task",
      "create",
      "graph",
      `${title} definition.`,
      "--title",
      title,
      ...flags,
      "--json",
    ),
  ).task;
}

let daemon: Daemon;

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-task-graph-cli-"));
  remote = join(tmp, "transport.git");
  aliceHome = join(tmp, "alice");
  bobHome = join(tmp, "bob");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  assert.equal(
    (await alice("init", "--repo", remote, "--network", "acme", "--agent", "alice-claude")).code,
    0,
  );
  assert.equal((await alice("room", "create", "graph")).code, 0);
  assert.equal(
    (await bob("init", "--repo", remote, "--network", "acme", "--agent", "bob-claude")).code,
    0,
  );
  assert.equal((await bob("room", "join", "graph")).code, 0);
  await writeFile(join(bobHome, "policy.yaml"), "v: 1\napprovals:\n  inboundWork: never\n");

  // Alice's commands go through a daemon, so the create fields cross the IPC
  // boundary; Bob's run in direct mode. Both paths must carry the graph.
  daemon = new Daemon({ layout: new Layout(aliceHome), notifier: "none", log: () => undefined });
  await daemon.start();
});

after(async () => {
  await daemon.stop();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("task create graph flags", () => {
  it("refuses malformed graph flags before anything is sent", async () => {
    const cases: [string[], RegExp][] = [
      [["--depends-on", "nope"], /--depends-on must be a task id/],
      [["--parent", "nope"], /--parent must be a task id/],
      [["--requires", "GPU"], /is not a capability name/],
      [["--requires", "gpu", "--requires", "gpu"], /names a capability twice/],
      [["--max-attempts", "0"], /--max-attempts must be an integer from 1 to 20/],
      [["--max-attempts", "21"], /--max-attempts must be an integer from 1 to 20/],
      [["--max-attempts", "1.5"], /--max-attempts must be an integer from 1 to 20/],
    ];
    for (const [flags, expected] of cases) {
      const result = await alice("task", "create", "graph", "Text.", "--title", "Bad", ...flags);
      assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, expected);
    }
  });

  it("carries every graph field through the daemon into the event", async () => {
    const schema = await create("Schema");
    const epic = await create("Epic");
    const api = await create(
      "API",
      "--depends-on",
      schema.id,
      "--parent",
      epic.id,
      "--requires",
      "gpu",
      "--requires",
      "cuda",
      "--max-attempts",
      "2",
    );
    assert.deepEqual(api.dependsOn, [schema.id]);
    assert.equal(api.parent, epic.id);
    assert.deepEqual(api.requires, ["gpu", "cuda"]);
    assert.equal(api.maxAttempts, 2);

    const human = await alice(
      "task",
      "create",
      "graph",
      "Docs.",
      "--title",
      "Docs",
      "--depends-on",
      api.id,
      "--parent",
      epic.id,
    );
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, new RegExp(`claimable once ${api.id} complete`));
    assert.match(human.stdout, new RegExp(`subtask of ${epic.id}`));
  });
});

describe("task graph in list, show, agenda and tree", () => {
  let schema: string;
  let epic: string;
  let api: string;

  before(async () => {
    schema = (await create("Schema step")).id;
    epic = (await create("Release epic")).id;
    api = (
      await create(
        "API step",
        "--depends-on",
        schema,
        "--parent",
        epic,
        "--requires",
        "gpu",
        "--max-attempts",
        "3",
      )
    ).id;
    await create("Docs step", "--parent", epic);
    await bob("sync");
  });

  it("shows readiness, requirements, attempts and subtask progress", async () => {
    const list = await bob("task", "list", "graph");
    assert.equal(list.code, 0, list.stderr);
    const apiLine = list.stdout.split("\n").find((line) => line.includes("API step")) ?? "";
    assert.match(apiLine, new RegExp(`waiting on ${schema.slice(-8)} \\(open\\)`));
    assert.match(apiLine, /requires gpu/);
    assert.match(apiLine, /attempt 0\/3/);
    const epicLine = list.stdout.split("\n").find((line) => line.includes("Release epic")) ?? "";
    assert.match(epicLine, /0\/2 subtasks done/);

    const show = await bob("task", "show", "graph", api);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, new RegExp(`parent +${epic}`));
    assert.match(show.stdout, new RegExp(`depends on ${schema} \\(open\\)`));
    assert.match(show.stdout, /ready +waiting on/);
    assert.match(show.stdout, /requires +gpu/);
    assert.match(show.stdout, /attempts +0\/3/);

    const json = parseJson<{ ready: boolean; waitingOn: { id: string; state: string }[] }>(
      await bob("task", "show", "graph", api, "--json"),
    );
    assert.equal(json.ready, false);
    assert.deepEqual(json.waitingOn, [{ id: schema, state: "open" }]);
  });

  it("refuses a claim on a task that is not ready, with its code in the message", async () => {
    const result = await bob("task", "claim", "graph", api, "Taking it.");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error \[DEPENDENCY_PENDING\]: waiting on/);
  });

  it("lists capability work under --capable once the profile declares it", async () => {
    await bob("task", "claim", "graph", schema, "Schema first.");
    await bob("task", "update", "graph", schema, "started", "Migrating.");
    await bob("task", "update", "graph", schema, "completed", "Done.");
    assert.equal((await bob("profile", "update", "--capability", "gpu")).code, 0);

    const agenda = parseJson<{
      entries: { relation: string; ready: boolean; status: { task: { id: string } } }[];
    }>(await bob("task", "agenda", "--capable", "--json"));
    const entry = agenda.entries.find((candidate) => candidate.status.task.id === api);
    assert.equal(entry?.relation, "capable");
    assert.equal(entry?.ready, true);

    const human = await bob("task", "agenda", "--capable");
    assert.match(human.stdout, /capable/);
  });

  it("prints the tree with parents, children and dependency edges", async () => {
    const tree = await bob("task", "tree", "graph", epic);
    assert.equal(tree.code, 0, tree.stderr);
    const lines = tree.stdout.trimEnd().split("\n");
    assert.match(lines[0] ?? "", new RegExp(`^${epic} open Release epic`));
    assert.ok(
      lines.some((line) => /^├─ .*API step/.test(line)),
      tree.stdout,
    );
    assert.ok(
      lines.some((line) => /^└─ .*Docs step/.test(line)),
      tree.stdout,
    );
    assert.ok(
      lines.some((line) => line.includes(`⇠ needs ${schema} (completed)`)),
      tree.stdout,
    );

    const json = parseJson<{ id: string; children: { id: string }[] }[]>(
      await bob("task", "tree", "graph", "--json"),
    );
    const root = json.find((node) => node.id === epic);
    assert.equal(root?.children.length, 2);
    assert.ok(!json.some((node) => node.id === api), "a subtask is not a root");

    const missing = await bob("task", "tree", "graph", "01J8XR7K9MQ4Z2N8P0VWXYZAB9");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no task/);
  });
});
