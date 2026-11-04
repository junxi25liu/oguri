import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import type { FeishuIntakePolicy } from "@oguri/core";

import { FeishuClient } from "../src/feishu/client.ts";
import { FeishuSource } from "../src/feishu/source.ts";
import { emptyState, type IntakeStateData } from "../src/state.ts";
import { APP, BOT, FakeFeishu } from "./fake-feishu.ts";

/**
 * The Feishu source against a loopback Feishu: what it reads, where it
 * resumes, and how it waits out a failing API.
 */

const feishu = new FakeFeishu();
let base: string;
let clock: number;
const T0 = Date.parse("2026-11-03T10:00:00.000Z");

function policy(overrides: Partial<FeishuIntakePolicy> = {}): FeishuIntakePolicy {
  return {
    appId: APP,
    appSecret: "APP-SECRET-VALUE",
    apiUrl: base,
    pollSeconds: 10,
    allowed: ["ou_alice"],
    direct: false,
    chats: [{ id: "oc_team", room: "ops", anyone: false }],
    ...overrides,
  };
}

function source(state: IntakeStateData, overrides: Partial<FeishuIntakePolicy> = {}): FeishuSource {
  const p = policy(overrides);
  return new FeishuSource({
    client: new FeishuClient({ appId: p.appId, appSecret: p.appSecret, apiUrl: base }),
    policy: p,
    state,
    now: () => clock,
  });
}

const mention = (text: string) => ({
  text: `@_user_1 ${text}`,
  mentions: [{ key: "@_user_1", id: { open_id: BOT }, name: "Oguri" }],
});

before(async () => {
  base = await feishu.start();
});
after(async () => {
  await feishu.stop();
});
beforeEach(() => {
  feishu.reset();
  feishu.chats.set("oc_team", { name: "Team", chat_mode: "group" });
  clock = T0;
});

describe("FeishuSource", () => {
  it("starts at now, so a chat's history is never ingested", async () => {
    feishu.add("oc_team", { ...mention("old request"), create_time: String(T0 - 60_000) });
    const state = emptyState();
    const s = source(state);
    assert.deepEqual(await s.poll(), []);
    await s.commit([]);
    assert.equal(state.cursors["oc_team"]?.ms, T0);
    assert.equal(state.botId, BOT);
    assert.equal(state.chats["oc_team"]?.mode, "group");
  });

  it("reads a mention as a request-shaped message with its thread and parent", async () => {
    const state = emptyState();
    const s = source(state);
    await s.poll();
    await s.commit([]);
    feishu.add("oc_team", {
      ...mention("fix the button"),
      create_time: String(T0 + 1000),
      root_id: "om_root",
      parent_id: "om_parent",
    });
    const [m] = await s.poll();
    assert.ok(m !== undefined);
    assert.equal(m.text, "fix the button");
    assert.equal(m.addressed, "mention");
    assert.equal(m.parent, "om_parent");
    assert.equal(m.at, new Date(T0 + 1000).toISOString());
    assert.deepEqual(m.external, {
      source: "feishu",
      id: m.external.id,
      conversation: "oc_team",
      thread: "om_root",
      actor: "ou_alice",
      human: true,
    });
    assert.match(
      m.url ?? "",
      /^https:\/\/applink\.feishu\.cn\/client\/chat\/open\?openChatId=oc_team$/,
    );
  });

  it("drops the bot's own messages and marks other apps as not human", async () => {
    const state = emptyState();
    const s = source(state);
    await s.poll();
    await s.commit([]);
    feishu.add("oc_team", { text: "ack", from: APP, app: true, create_time: String(T0 + 1) });
    feishu.add("oc_team", { text: "ack", from: BOT, app: true, create_time: String(T0 + 2) });
    feishu.add("oc_team", {
      text: "ci done",
      from: "cli_other",
      app: true,
      create_time: String(T0 + 3),
    });
    const messages = await s.poll();
    assert.deepEqual(
      messages.map((m) => [m.external.actor, m.external.human]),
      [["cli_other", false]],
    );
  });

  it("follows page_token through every page", async () => {
    const state = emptyState();
    const s = source(state);
    await s.poll();
    await s.commit([]);
    feishu.pageSize = 2;
    for (let i = 1; i <= 5; i += 1)
      feishu.add("oc_team", { text: `m${String(i)}`, create_time: String(T0 + i) });
    const messages = await s.poll();
    assert.deepEqual(
      messages.map((m) => m.text),
      ["m1", "m2", "m3", "m4", "m5"],
    );
    const pages = feishu.calls("/open-apis/im/v1/messages").slice(-3);
    assert.deepEqual(
      pages.map((hit) => hit.query.get("page_token")),
      [null, "2", "4"],
    );
    assert.equal(pages[0]?.query.get("sort_type"), "ByCreateTimeAsc");
    assert.equal(pages[0]?.query.get("start_time"), String(Math.floor(T0 / 1000)));
  });

  it("neither replays nor skips across a restart, even at one millisecond", async () => {
    const state = emptyState();
    let s = source(state);
    await s.poll();
    await s.commit([]);
    const first = feishu.add("oc_team", { text: "first", create_time: String(T0 + 500) });
    const read = await s.poll();
    assert.deepEqual(
      read.map((m) => m.text),
      ["first"],
    );
    await s.commit(read);
    // Restart: a new source over the persisted state, then a message in the same millisecond.
    const persisted = JSON.parse(JSON.stringify(state)) as IntakeStateData;
    s = source(persisted);
    feishu.add("oc_team", { text: "same ms", create_time: String(T0 + 500) });
    const again = await s.poll();
    assert.deepEqual(
      again.map((m) => m.text),
      ["same ms"],
    );
    await s.commit(again);
    assert.equal(persisted.cursors["oc_team"]?.ms, T0 + 500);
    assert.equal(persisted.cursors["oc_team"]?.ids.length, 2);
    assert.ok(persisted.cursors["oc_team"]?.ids.includes(first.message_id));
    assert.deepEqual(await s.poll(), []);
  });

  it("returns an unhandled message, and everything after it, on the next poll", async () => {
    const state = emptyState();
    const s = source(state);
    await s.poll();
    await s.commit([]);
    feishu.add("oc_team", { text: "a", create_time: String(T0 + 1) });
    feishu.add("oc_team", { text: "b", create_time: String(T0 + 2) });
    feishu.add("oc_team", { text: "c", create_time: String(T0 + 3) });
    const [a, b] = await s.poll();
    // `b` failed to write; `a` succeeded. `c` must wait behind `b`.
    await s.commit([a as NonNullable<typeof a>]);
    assert.deepEqual(
      (await s.poll()).map((m) => m.text),
      ["b", "c"],
    );
    void b;
  });

  it("backs off after a transient failure and recovers", async () => {
    const state = emptyState();
    const s = source(state);
    await s.poll();
    await s.commit([]);
    feishu.add("oc_team", { text: "wait for me", create_time: String(T0 + 1) });
    feishu.failures.set("/open-apis/im/v1/messages", { status: 503, code: 0, times: 1 });
    assert.deepEqual(await s.poll(), []);
    const health = s.health();
    assert.match(health.lastError?.message ?? "", /HTTP 503/);
    assert.equal(health.backoffUntil, new Date(T0 + 10_000).toISOString());

    const before = feishu.calls("/open-apis/im/v1/messages").length;
    assert.deepEqual(await s.poll(), [], "no call during the backoff");
    assert.equal(feishu.calls("/open-apis/im/v1/messages").length, before);

    clock = T0 + 10_000;
    assert.deepEqual(
      (await s.poll()).map((m) => m.text),
      ["wait for me"],
    );
  });

  it("reports a chat it cannot read and keeps reading the others", async () => {
    feishu.chats.set("oc_second", { name: "Second", chat_mode: "group" });
    const state = emptyState();
    const s = source(state, {
      chats: [
        { id: "oc_gone", room: "ops", anyone: false },
        { id: "oc_second", room: "ops", anyone: false },
      ],
    });
    await s.poll();
    await s.commit([]);
    feishu.add("oc_second", { text: "still here", create_time: String(T0 + 1) });
    assert.deepEqual(
      (await s.poll()).map((m) => m.text),
      ["still here"],
    );
    assert.match(s.health().lastError?.message ?? "", /code 232011/);
    assert.equal(s.health().backoffUntil, undefined, "a refusal is not retried faster or slower");
  });

  it("treats a listed p2p chat as direct messages", async () => {
    feishu.chats.set("oc_dm", { name: "", chat_mode: "p2p" });
    const state = emptyState();
    const s = source(state, {
      direct: true,
      directRoom: "ops",
      chats: [{ id: "oc_dm", room: "ops", anyone: false }],
    });
    await s.poll();
    await s.commit([]);
    feishu.add("oc_dm", { text: "no mention needed", create_time: String(T0 + 1) });
    const [m] = await s.poll();
    assert.equal(m?.addressed, "direct");
  });
});

describe("FeishuClient envelope", () => {
  it("returns a reply that answers beside `code` rather than under `data`", async () => {
    const client = new FeishuClient({ appId: APP, appSecret: "s", apiUrl: base });
    const info = await client.call<{ bot?: { open_id?: string } }>({
      method: "GET",
      path: "/open-apis/bot/v3/info",
    });
    assert.equal(info.bot?.open_id, BOT);
    const chat = await client.call<{ name?: string }>({
      method: "GET",
      path: "/open-apis/im/v1/chats/oc_team",
    });
    assert.equal(chat.name, "Team");
  });
});
