import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Layout, type TaskDetail } from "@oguri/core";
import { openBackend, type Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import { listRuns, readConsumed } from "../src/runs.ts";

/**
 * Follow-up on a completed task, driven through `oguri worker start --once`.
 *
 * The acceptance probe sent its follow-up with plain `oguri send` and saw no
 * new run. A follow-up is a person's message relayed by the task's creator
 * with an `external.human` header; a plain message is a plain message. This
 * runs both through the built binary against a real transport repository, with
 * a fake runner that records every call and keeps one session per task.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");
const SESSION = "9a1b2c3d-0000-4aaa-8bbb-abcdefabcdef";

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const RUNNER = `
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input }) + "\\n");
  const resumed = process.argv.includes("--resume");
  console.log(JSON.stringify({
    type: "result",
    session_id: ${JSON.stringify(SESSION)},
    result: resumed ? "second answer" : "first answer",
  }));
});
`;

let tmp: string;
let aliceHome: string;
let bobHome: string;
let calls: string;
let alice: Backend;
let env: NodeJS.ProcessEnv;

async function oguri(home: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], {
    env: { ...env, OGURI_HOME: home },
  });
  return stdout;
}

async function callCount(): Promise<number> {
  try {
    return (await readFile(calls, "utf8")).trim().split("\n").length;
  } catch {
    return 0;
  }
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-followup-cli-"));
  aliceHome = join(tmp, "alice");
  bobHome = join(tmp, "bob");
  calls = join(tmp, "calls.jsonl");
  const remote = join(tmp, "transport.git");
  const script = join(tmp, "runner.cjs");
  env = { ...process.env, NO_COLOR: "1", CALLS_FILE: calls };
  delete env["OGURI_AGENT"];
  delete env["OGURI_HOME"];
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri(aliceHome, "init", "--repo", remote, "--network", "acme", "--agent", "alice-claude");
  await oguri(aliceHome, "room", "create", "ops", "--title", "Ops");
  await oguri(bobHome, "init", "--repo", remote, "--network", "acme", "--agent", "bob-claude");
  await oguri(bobHome, "room", "join", "ops");
  await writeFile(script, RUNNER);
  const argv = [process.execPath, script, "-p", "--output-format", "json"];
  await writeFile(
    join(bobHome, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      "  concurrency: 1",
      "  maxPerHour: 40",
      "  timeoutMinutes: 1",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  runners:",
      "    chat:",
      `      argv: ${JSON.stringify(argv)}`,
      `      resume: ${JSON.stringify([...argv, "--resume", "{session}"])}`,
      "      session: claude-json",
      '  trustedRequesters: ["alice-claude"]',
      "",
    ].join("\n"),
  );
  alice = await openBackend({ layout: new Layout(aliceHome), forceDirect: true });
});

after(async () => {
  await alice?.close();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a follow-up on a completed task, through `worker start --once`", () => {
  it("ignores a plain message, and resumes the same session for a relayed person's message", async () => {
    const created = await alice.call<Message>("taskCreate", {
      room: "ops",
      input: { title: "Ask", definition: "Answer the question.", target: "bob-claude" },
    });
    const taskId = created.header.task?.id as string;
    const thread = created.header.thread;

    await oguri(bobHome, "worker", "start", "--once");
    await alice.call("sync");
    const done = await alice.call<TaskDetail>("taskShow", { room: "ops", taskId });
    assert.equal(done.task.state, "completed");
    assert.equal(await callCount(), 1);
    const [first] = await listRuns(bobHome);
    assert.equal(first?.sessionId, SESSION);
    assert.equal(first?.thread, thread);
    assert.equal(first?.outcome, "completed");
    assert.match(first?.note ?? "", /no result\.json written/, "the missing file is on the record");
    assert.match(done.events.at(-1)?.body ?? "", /no result\.json was written/);

    // What the acceptance probe did: a plain `oguri send` into the thread.
    await oguri(
      aliceHome,
      "send",
      "ops",
      "please also add a note",
      "--reply-to",
      thread,
      "--mention",
      "bob-claude",
    );
    await oguri(bobHome, "worker", "start", "--once");
    assert.equal(await callCount(), 1, "a plain message is not a follow-up");

    // What intake does for a person in a chat: the creator relays them.
    await alice.call("send", {
      room: "ops",
      input: {
        body: "Also add a note about the cancel button.",
        thread,
        inReplyTo: thread,
        external: {
          source: "feishu",
          id: "om_followup",
          conversation: "oc_team",
          actor: "ou_bob",
          actorName: "Bob",
          human: true,
        },
      },
    });
    await oguri(bobHome, "worker", "start", "--once");

    const recorded = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; input: string });
    assert.equal(recorded.length, 2, "the relayed message ran the task again");
    assert.deepEqual(recorded[1]?.argv.slice(-2), ["--resume", SESSION], "in the same session");
    assert.equal(recorded[1]?.cwd, recorded[0]?.cwd, "in the same directory");
    assert.match(recorded[1]?.input ?? "", /Bob: Also add a note about the cancel button\./);

    const runs = (await listRuns(bobHome)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const followup = runs.at(-1);
    assert.equal(runs.length, 2);
    assert.equal(followup?.followup, true);
    assert.equal(followup?.resumed, true);
    assert.equal(followup?.sessionId, SESSION);
    assert.equal(followup?.outcome, "answered", "alice created it, so the task stays completed");
    assert.equal((await readConsumed(bobHome, taskId)).size, 1);

    await alice.call("sync");
    const after = await alice.call<TaskDetail>("taskShow", { room: "ops", taskId });
    assert.equal(after.task.state, "completed");
    const reply = (await alice.call<Message[]>("read", { room: "ops", thread })).findLast(
      (message) => message.header.from === "bob-claude" && message.body.includes("second answer"),
    );
    assert.ok(reply, "the follow-up's answer is in the thread");

    // The same message never runs twice.
    await oguri(bobHome, "worker", "start", "--once");
    assert.equal(await callCount(), 2);
  });
});
