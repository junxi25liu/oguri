import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { DEFAULT_INTAKE_POLICY, intakePolicyVersion, type IntakePolicy } from "@oguri/core";

import { Intake, intakeResource } from "../src/intake.ts";
import type { OutboundReply, Outbox } from "../src/outbox/types.ts";
import { CONTEXT_TAG } from "../src/request.ts";
import { readIntakeState, writeIntakeState } from "../src/state.ts";
import { FakeBackend } from "./fake-backend.ts";
import { APP, BOT, FakeFeishu } from "./fake-feishu.ts";

/**
 * The intake loop over a fake backend and a loopback Feishu: requests become
 * tasks, follow-ups join their task's thread, a restart writes nothing twice,
 * and a second machine stays idle.
 */

const feishu = new FakeFeishu();
let base: string;
let tmp: string;
let home: string;
let backend: FakeBackend;
let outbox: MemoryOutbox;

class MemoryOutbox implements Outbox {
  queued: OutboundReply[] = [];
  flushes = 0;
  enqueue(reply: OutboundReply): Promise<void> {
    this.queued.push(reply);
    return Promise.resolve();
  }
  flush(): Promise<void> {
    this.flushes += 1;
    return Promise.resolve();
  }
}

function policy(overrides: Partial<NonNullable<IntakePolicy["feishu"]>> = {}): IntakePolicy {
  return {
    ...DEFAULT_INTAKE_POLICY,
    enabled: true,
    feishu: {
      appId: APP,
      appSecret: "APP-SECRET-VALUE",
      apiUrl: base,
      pollSeconds: 10,
      allowed: ["ou_alice"],
      direct: false,
      chats: [
        { id: "oc_team", room: "ops", target: "machine:build", requires: ["gpu"], anyone: false },
      ],
      ...overrides,
    },
  };
}

function intake(p: IntakePolicy = policy()): Intake {
  return new Intake({ backend, agentId: backend.agentId, home, loadPolicy: async () => p, outbox });
}

const mention = (text: string) => ({
  text: `@_user_1 ${text}`,
  mentions: [{ key: "@_user_1", id: { open_id: BOT }, name: "Oguri" }],
});

/** A chat message written after the first poll set the read position. */
function later(fields: Parameters<FakeFeishu["add"]>[1]) {
  return feishu.add("oc_team", { create_time: String(Date.now() + 5), ...fields });
}

before(async () => {
  base = await feishu.start();
});
after(async () => {
  await feishu.stop();
});
beforeEach(async () => {
  feishu.reset();
  feishu.chats.set("oc_team", { name: "Team", chat_mode: "group" });
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  tmp = await mkdtemp(join(tmpdir(), "oguri-intake-"));
  home = join(tmp, "home");
  backend = new FakeBackend();
  outbox = new MemoryOutbox();
});

describe("Intake", () => {
  it("creates a task in the chat's room with origin, mandate, target and requirements", async () => {
    const p = policy();
    const i = intake(p);
    await i.poll();
    assert.deepEqual(backend.subscriptions, ["ops"], "joins the room it writes to");
    const asked = later({
      ...mention("Fix the cancel button\nIt overlaps the total on mobile."),
      root_id: "om_root",
    });
    const report = await i.poll();
    assert.equal(report.created.length, 1);

    const [task] = backend.created;
    assert.ok(task !== undefined);
    const t = task.header.task;
    assert.equal(task.header.room, "ops");
    assert.equal(t?.title, "Fix the cancel button");
    assert.equal(t?.target, "machine:build");
    assert.deepEqual(t?.requires, ["gpu"]);
    assert.deepEqual(t?.origin, {
      source: "feishu",
      conversation: "oc_team",
      message: asked.message_id,
      thread: "om_root",
      requester: "ou_alice",
      url: "https://applink.feishu.cn/client/chat/open?openChatId=oc_team",
    });
    assert.deepEqual(t?.mandate, {
      strength: "explicit",
      via: "addressed",
      policy: intakePolicyVersion(p),
    });
    assert.match(
      task.body,
      /^Fix the cancel button\nIt overlaps the total on mobile\.\n\nRequested by ou_alice in Feishu: https:/,
    );
    assert.equal(outbox.queued.length, 0, "intake does not acknowledge; the worker does");
    assert.ok(outbox.flushes >= 2, "the outbox is flushed every poll");
  });

  it("relays a follow-up into the task's thread, as the person who wrote it", async () => {
    const i = intake();
    await i.poll();
    const asked = later({ ...mention("Fix the button") });
    await i.poll();
    const task = backend.created[0];
    assert.ok(task !== undefined);

    // A reply in the request's thread, not mentioning the bot.
    const reply = later({
      text: "also the colour",
      root_id: asked.message_id,
      parent_id: asked.message_id,
    });
    const report = await i.poll();
    assert.equal(report.relayed.length, 1);
    const [sent] = backend.sent;
    assert.ok(sent !== undefined);
    assert.equal(sent.header.thread, task.header.thread);
    assert.equal(sent.header.kind, "msg");
    assert.equal(sent.header.authorKind, "human");
    assert.equal(sent.header.needs, "agent");
    assert.deepEqual(sent.header.mentions, ["machine:build"]);
    assert.equal(sent.body, "also the colour");
    assert.deepEqual(sent.header.external, {
      source: "feishu",
      id: reply.message_id,
      conversation: "oc_team",
      thread: asked.message_id,
      actor: "ou_alice",
      human: true,
    });
  });

  it("relays a stranger's follow-up as context that asks nothing", async () => {
    const i = intake();
    await i.poll();
    const asked = later({ ...mention("Fix the button") });
    await i.poll();
    later({ text: "me too", from: "ou_stranger", root_id: asked.message_id });
    const report = await i.poll();
    assert.equal(report.relayed[0]?.admitted, false);
    const [sent] = backend.sent;
    assert.equal(sent?.header.needs, "none");
    assert.deepEqual(sent?.header.tags, [CONTEXT_TAG]);
  });

  it("ignores a stranger's request and a chat message that does not address the bot", async () => {
    const i = intake();
    await i.poll();
    later({ ...mention("delete prod"), from: "ou_stranger" });
    later({ text: "lunch?" });
    const report = await i.poll();
    assert.equal(backend.created.length, 0);
    assert.equal(report.ignored.length, 2);
  });

  it("never creates a second task for one message after a restart that lost its place", async () => {
    await intake().poll();
    later({ ...mention("Fix the button") });
    await intake().poll();
    assert.equal(backend.created.length, 1);

    // The state file is a cache: rewind its read position, as a crash before
    // the write would, and start a new process. The room already relays it.
    const state = await readIntakeState(home);
    state.cursors["oc_team"] = { ms: (state.cursors["oc_team"]?.ms ?? 0) - 60_000, ids: [] };
    await writeIntakeState(home, state);
    const report = await intake().poll();
    assert.equal(report.created.length, 0);
    assert.equal(backend.created.length, 1);
  });

  it("rebuilds the thread → task map from the rooms on start", async () => {
    await intake().poll();
    const asked = later({ ...mention("Fix the button") });
    await intake().poll();
    // A new process: the task map comes back from `tasks`, not the file.
    const restarted = intake();
    later({ text: "and the footer", parent_id: asked.message_id });
    const report = await restarted.poll();
    assert.equal(report.relayed.length, 1);
    assert.equal(report.relayed[0]?.taskId, backend.created[0]?.header.task?.id);
  });

  it("stays idle while another machine holds the intake claim, and says who", async () => {
    backend.claimHolder = "carol-intake";
    const report = await intake().poll();
    assert.match(report.idle ?? "", /held by carol-intake/);
    assert.equal(feishu.calls("/open-apis/im/v1/messages").length, 0, "reads nothing from chat");
    const state = await readIntakeState(home);
    assert.equal(state.status.claim?.holder, "carol-intake");
    assert.equal(state.status.claim?.mine, false);
    assert.equal(state.status.claim?.resource, intakeResource("feishu", APP));
    assert.equal(intakeResource("feishu", APP), "intake:feishu:cli-test");
  });

  it("renews the claim at half-life, not every poll", async () => {
    const i = intake();
    await i.poll();
    await i.poll();
    await i.poll();
    assert.equal(backend.calls.filter((c) => c.method === "claim").length, 1);
    await i.release();
    assert.equal(backend.calls.filter((c) => c.method === "claimRelease").length, 1);
  });

  it("does nothing while intake is disabled", async () => {
    const report = await intake({ ...policy(), enabled: false }).poll();
    assert.equal(report.idle, "intake.enabled is false");
    assert.equal(feishu.hits.length, 0);
  });

  it("replies with a short refusal when the scanner refuses a request, never the error", async () => {
    const i = intake();
    await i.poll();
    const asked = later({ ...mention("deploy with AKIAIOSFODNN7EXAMPLE") });
    backend.failures.set("taskCreate", {
      error: Object.assign(new Error("refusing to send: possible secret detected — aws"), {
        code: "SECRET_DETECTED",
      }),
      times: 1,
    });
    const report = await i.poll();
    assert.equal(report.refused.length, 1);
    const [reply] = outbox.queued;
    assert.equal(reply?.replyTo, asked.message_id);
    assert.equal(reply?.conversation, "oc_team");
    assert.equal(reply?.purpose, "attention");
    assert.match(reply?.text ?? "", /secret/);
    assert.doesNotMatch(reply?.text ?? "", /AKIA/);
    assert.equal(backend.created.length, 0);
  });

  it("retries a write that failed for a passing reason, before later messages", async () => {
    const i = intake();
    await i.poll();
    later({ ...mention("first") });
    later({ ...mention("second") });
    backend.failures.set("taskCreate", { error: new Error("push rejected"), times: 1 });
    const report = await i.poll();
    assert.equal(report.created.length, 0, "the second waits behind the first");
    await i.poll();
    assert.deepEqual(
      backend.created.map((m) => m.header.task?.title),
      ["first", "second"],
    );
    assert.equal(outbox.queued.length, 0);
  });

  it("records a Feishu outage in status and backs off", async () => {
    const i = intake();
    await i.poll();
    feishu.failures.set("/open-apis/im/v1/messages", { status: 429, code: 99991400, times: 5 });
    await i.poll();
    const state = await readIntakeState(home);
    assert.match(state.status.lastError?.message ?? "", /code 99991400/);
    assert.ok(state.status.backoffUntil !== undefined);
    assert.doesNotMatch(JSON.stringify(state), /APP-SECRET-VALUE/);
  });
});
