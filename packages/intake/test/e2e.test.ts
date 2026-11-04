import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Layout } from "@oguri/core";
import { openBackend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import { APP, BOT, FakeFeishu } from "./fake-feishu.ts";

/**
 * Intake end to end: a person mentions the bot in a Feishu chat, `oguri
 * intake start --once` reads it from a loopback Feishu, and a second agent on
 * another clone sees a task with its origin through a real bare transport
 * repository. A follow-up in the chat then reaches the same task's thread.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const feishu = new FakeFeishu();
let tmp: string;
let intakeHome: string;
let bobHome: string;
let base: string;

async function oguri(home: string, ...args: string[]): Promise<Result> {
  const env = { ...process.env, OGURI_HOME: home, NO_COLOR: "1" };
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args, "--direct"], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function setPolicy(enabled: boolean): Promise<void> {
  await writeFile(
    join(intakeHome, "policy.yaml"),
    [
      "v: 1",
      "intake:",
      `  enabled: ${String(enabled)}`,
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
}

const mention = (text: string) => ({
  text: `@_user_1 ${text}`,
  mentions: [{ key: "@_user_1", id: { open_id: BOT }, name: "Oguri" }],
});

before(async () => {
  await access(CLI);
  base = await feishu.start();
  feishu.chats.set("oc_team", { name: "Team", chat_mode: "group" });
  tmp = await mkdtemp(join(tmpdir(), "oguri-intake-e2e-"));
  const remote = join(tmp, "transport.git");
  intakeHome = join(tmp, "intake");
  bobHome = join(tmp, "bob");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  const init = (home: string, agent: string) =>
    oguri(home, "init", "--repo", remote, "--network", "acme", "--agent", agent);
  assert.equal((await init(intakeHome, "team-intake")).code, 0);
  assert.equal((await oguri(intakeHome, "room", "create", "ops")).code, 0);
  assert.equal((await init(bobHome, "bob-claude")).code, 0);
  assert.equal((await oguri(bobHome, "room", "join", "ops")).code, 0);
});

after(async () => {
  await feishu.stop();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri intake, end to end", () => {
  it("refuses to start until the machine owner enables it", async () => {
    await setPolicy(false);
    const result = await oguri(intakeHome, "intake", "start", "--once");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /intake is disabled/);
    assert.match(result.stdout, /intake\.enabled: true/);
  });

  it("proves the credentials with intake test", async () => {
    await setPolicy(true);
    const result = await oguri(intakeHome, "intake", "test", "--json");
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { botId: string; chats: { name?: string }[] };
    assert.equal(parsed.botId, BOT);
    assert.equal(parsed.chats[0]?.name, "Team");
  });

  it("turns a Feishu mention into a task another machine sees with its origin", async () => {
    // The first pass sets the read position at now; history is not ingested.
    feishu.add("oc_team", { ...mention("old request"), create_time: String(Date.now() - 60_000) });
    const first = await oguri(intakeHome, "intake", "start", "--once");
    assert.equal(first.code, 0, first.stderr + first.stdout);

    const asked = feishu.add("oc_team", {
      ...mention("Fix the cancel button"),
      create_time: String(Date.now() + 10),
    });
    const second = await oguri(intakeHome, "intake", "start", "--once");
    assert.equal(second.code, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /created task/);

    assert.equal((await oguri(bobHome, "sync")).code, 0);
    const listed = await oguri(bobHome, "task", "list", "ops", "--json");
    const tasks = JSON.parse(listed.stdout) as {
      task: {
        id: string;
        title: string;
        target?: string;
        creator: string;
        origin?: { source: string; message: string; requester: string; conversation: string };
        mandate?: { strength: string; via: string };
      };
    }[];
    assert.equal(tasks.length, 1, "one task, and not the old request");
    const task = tasks[0]?.task;
    assert.equal(task?.title, "Fix the cancel button");
    assert.equal(task?.target, "bob-claude");
    assert.equal(task?.creator, "team-intake");
    assert.deepEqual(
      { ...task?.origin },
      {
        source: "feishu",
        conversation: "oc_team",
        message: asked.message_id,
        requester: "ou_alice",
        url: "https://applink.feishu.cn/client/chat/open?openChatId=oc_team",
      },
    );
    assert.equal(task?.mandate?.via, "addressed");

    // A follow-up in the request's reply chain reaches the same thread, once.
    feishu.add("oc_team", {
      text: "also the colour",
      parent_id: asked.message_id,
      root_id: asked.message_id,
      create_time: String(Date.now() + 20),
    });
    const third = await oguri(intakeHome, "intake", "start", "--once");
    assert.equal(third.code, 0, third.stderr);
    assert.equal((await oguri(intakeHome, "intake", "start", "--once")).code, 0);
    assert.equal((await oguri(bobHome, "sync")).code, 0);
    // Read on Bob's clone, so the headers asserted are the ones that crossed git.
    const backend = await openBackend({ layout: new Layout(bobHome), forceDirect: true });
    try {
      const messages = await backend.call<Message[]>("read", { room: "ops" });
      const root = messages.find((m) => m.header.task?.id === task?.id);
      const followups = messages.filter((m) => m.header.external !== undefined);
      assert.equal(followups.length, 1, "relayed once across two passes");
      const [followup] = followups;
      assert.equal(followup?.body.trim(), "also the colour");
      assert.equal(followup?.header.thread, root?.header.thread, "in the task's own thread");
      assert.equal(followup?.header.authorKind, "human");
      assert.equal(followup?.header.from, "team-intake");
      assert.equal(followup?.header.external?.actor, "ou_alice");
      assert.equal(followup?.header.external?.human, true);
    } finally {
      await backend.close();
    }
  });

  it("reports status without the secret", async () => {
    const result = await oguri(intakeHome, "intake", "status", "--json");
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /APP-SECRET-VALUE/);
    const status = JSON.parse(result.stdout) as {
      enabled: boolean;
      botId: string;
      claim: { holder: string; mine: boolean } | null;
      chats: { id: string; room: string }[];
      lastPollAt: string | null;
    };
    assert.equal(status.enabled, true);
    assert.equal(status.botId, BOT);
    assert.equal(status.claim, null, "a --once run gives its claim back");
    assert.deepEqual(
      status.chats.map((c) => [c.id, c.room]),
      [["oc_team", "ops"]],
    );
    assert.ok(status.lastPollAt !== null);
    const text = await oguri(intakeHome, "intake", "status");
    assert.doesNotMatch(text.stdout, /APP-SECRET-VALUE/);
    assert.match(text.stdout, /oc_team/);
  });
});
