import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

import { APP, BOT, FakeFeishu } from "../../intake/test/fake-feishu.ts";

/**
 * The whole chat loop across two machines (ADR 0030).
 *
 * A person mentions the bot in a loopback Feishu. Intake on one home turns it
 * into a task; a worker on another home, reached only through a real bare
 * transport repository, runs it with a Claude-style runner. The acknowledgement
 * and result come back to the chat under the request. A follow-up in the thread
 * resumes the same session, and its answer comes back too. Someone not on the
 * allowed list cannot start a run.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
const SESSION = "11111111-2222-3333-4444-555555555555";

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const RUNNER = `
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ argv: process.argv.slice(2), input }) + "\\n");
  const resumed = process.argv.includes("--resume");
  console.log(JSON.stringify({
    type: "result",
    session_id: ${JSON.stringify(SESSION)},
    result: resumed ? "Renamed the cancel button too." : "Renamed the save button.",
  }));
});
`;

const feishu = new FakeFeishu();
let tmp: string;
let intakeHome: string;
let bobHome: string;
let calls: string;

async function oguri(home: string, ...args: string[]): Promise<string> {
  const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1", CALLS_FILE: calls });
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
  return stdout;
}

const intakePass = () => oguri(intakeHome, "intake", "start", "--once");
const workerPass = () => oguri(bobHome, "worker", "start", "--once");

async function runnerCalls(): Promise<{ argv: string[]; input: string }[]> {
  const raw = await readFile(calls, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { argv: string[]; input: string });
}

before(async () => {
  await access(CLI);
  const base = await feishu.start();
  feishu.chats.set("oc_team", { name: "Team", chat_mode: "group" });
  tmp = await mkdtemp(join(tmpdir(), "oguri-chat-loop-"));
  calls = join(tmp, "calls.jsonl");
  const remote = join(tmp, "transport.git");
  intakeHome = join(tmp, "intake");
  bobHome = join(tmp, "bob");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri(intakeHome, "init", "--repo", remote, "--network", "acme", "--agent", "team-intake");
  await oguri(intakeHome, "room", "create", "ops");
  await oguri(bobHome, "init", "--repo", remote, "--network", "acme", "--agent", "bob-claude");
  await oguri(bobHome, "room", "join", "ops");

  await writeFile(
    join(intakeHome, "policy.yaml"),
    [
      "v: 1",
      "intake:",
      "  enabled: true",
      "  feishu:",
      `    appId: ${APP}`,
      "    appSecret: APP-SECRET-VALUE",
      `    apiUrl: ${JSON.stringify(base)}`,
      "    pollSeconds: 2",
      "    allowed: [ou_alice]",
      "    chats:",
      "      oc_team:",
      "        room: ops",
      "        target: bob-claude",
      "",
    ].join("\n"),
  );
  const script = join(tmp, "runner.cjs");
  await writeFile(script, RUNNER);
  const node = JSON.stringify(process.execPath);
  const path = JSON.stringify(script);
  await writeFile(
    join(bobHome, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      `  workdir: ${JSON.stringify(tmp)}`,
      "  trustedRequesters: [team-intake]",
      "  runners:",
      "    claude:",
      `      argv: [${node}, ${path}, -p, --output-format, json]`,
      `      resume: [${node}, ${path}, -p, --output-format, json, --resume, "{session}"]`,
      "      session: claude-json",
      "",
    ].join("\n"),
  );
  // The first pass sets the read position, so the request below is new.
  await intakePass();
});

after(async () => {
  await feishu.stop();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the chat loop", () => {
  let request: string;

  it("takes a mention to a result in the same conversation", async () => {
    const asked = feishu.add("oc_team", {
      text: "@_user_1 Rename the save button",
      mentions: [{ key: "@_user_1", id: { open_id: BOT }, name: "Oguri" }],
    });
    request = asked.message_id;

    await intakePass();
    assert.equal(feishu.replies.length, 0, "intake itself does not answer a request");

    await workerPass();
    const [first] = await runnerCalls();
    assert.ok(first !== undefined, "the worker on the other home ran the task");
    assert.match(first.input, /Rename the save button/);

    await intakePass();
    const texts = feishu.replies.map((reply) => reply.text);
    assert.equal(texts.length, 2, `one ack and one result, got ${JSON.stringify(texts)}`);
    assert.match(texts[0] ?? "", /^On it: /);
    assert.match(texts[1] ?? "", /Renamed the save button/);
    assert.ok(feishu.replies.every((reply) => reply.replyTo === request));

    await intakePass();
    assert.equal(feishu.replies.length, 2, "a later pass sends nothing twice");
  });

  it("resumes the same session for a follow-up in the thread and answers there", async () => {
    feishu.add("oc_team", {
      text: "Also the cancel button",
      root_id: request,
      parent_id: request,
    });
    await intakePass();
    await workerPass();

    const all = await runnerCalls();
    assert.equal(all.length, 2);
    const resumed = all[1];
    assert.deepEqual(resumed?.argv.slice(-2), ["--resume", SESSION]);
    assert.match(resumed?.input ?? "", /Also the cancel button/);

    await intakePass();
    const last = feishu.replies.at(-1);
    assert.equal(feishu.replies.length, 3);
    assert.match(last?.text ?? "", /Renamed the cancel button too/);
  });

  it("does not let someone off the allowed list start a run", async () => {
    feishu.add("oc_team", {
      text: "Delete the whole repository",
      from: "ou_mallory",
      root_id: request,
      parent_id: request,
    });
    await intakePass();
    await workerPass();
    assert.equal((await runnerCalls()).length, 2);

    const room = await oguri(bobHome, "read", "ops", "--json");
    assert.match(room, /Delete the whole repository/, "it still reaches the thread, as context");
  });
});
