import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { FeishuClient } from "../src/feishu/client.ts";
import { FeishuReplySender, FEISHU_UUID_LIMIT } from "../src/outbox/feishu-sender.ts";
import {
  FileOutbox,
  OUTBOX_RETENTION_MS,
  backoffMs,
  type FileOutboxOptions,
} from "../src/outbox/file-outbox.ts";
import type { OutboundReply } from "../src/outbox/types.ts";
import { FakeFeishu, TOKEN_PATH } from "./fake-feishu-replies.ts";

/**
 * The reply outbox (ADR 0030 §6) against a loopback Feishu: one send per key,
 * in order per conversation, retried with backoff, dropped when the target is
 * gone, and remembered across a restart.
 */

const feishu = new FakeFeishu();
let base: string;
let stateDir: string;
let clock: number;
const dirs: string[] = [];

function reply(key: string, overrides: Partial<OutboundReply> = {}): OutboundReply {
  return {
    key,
    source: "feishu",
    conversation: "oc_team",
    replyTo: `om_${key.replace(/[^a-z0-9]/gi, "")}`,
    text: `reply ${key}`,
    purpose: "result",
    ...overrides,
  };
}

function outbox(overrides: Partial<FileOutboxOptions> = {}): FileOutbox {
  const client = new FeishuClient({ appId: "cli_test", appSecret: "secret", apiUrl: base });
  return new FileOutbox({
    stateDir,
    senders: { feishu: new FeishuReplySender(client) },
    now: () => clock,
    ...overrides,
  });
}

/** A Feishu refusal with HTTP 400, the way Feishu sends one. */
function refusal(code: number) {
  return { status: 400, body: { code, msg: "refused" } };
}

before(async () => {
  base = await feishu.start();
});

after(async () => {
  await feishu.stop();
});

beforeEach(async () => {
  feishu.reset();
  stateDir = await mkdtemp(join(tmpdir(), "oguri-intake-outbox-"));
  dirs.push(stateDir);
  clock = Date.parse("2026-11-03T10:00:00Z");
});

describe("Feishu reply sender", () => {
  it("replies in thread as plain text, with the key as uuid", async () => {
    const box = outbox();
    const key = `relay:${"01JAAAAAAAAAAAAAAAAAAAAAAA"}:${"x".repeat(40)}`;
    await box.enqueue(reply(key, { replyTo: "om_ask", text: "Done: https://x.test/pr/1" }));
    await box.flush();

    assert.equal(feishu.hits[0]?.path, TOKEN_PATH);
    const [hit] = feishu.replies;
    assert.equal(hit?.path, "/open-apis/im/v1/messages/om_ask/reply");
    assert.equal(hit?.authorization, "Bearer t-fake");
    assert.deepEqual(hit?.body, {
      msg_type: "text",
      content: JSON.stringify({ text: "Done: https://x.test/pr/1" }),
      reply_in_thread: true,
      uuid: key.slice(0, FEISHU_UUID_LIMIT),
    });
    assert.equal(String(hit?.body["uuid"]).length, FEISHU_UUID_LIMIT);
    const status = await box.status();
    assert.deepEqual([status.queued, status.sent, status.dropped], [0, 1, 0]);
  });
});

describe("FileOutbox", () => {
  it("sends each key once, across a restart", async () => {
    const first = outbox();
    await first.enqueue(reply("a"));
    await first.enqueue(reply("a", { text: "a different text" }));
    await first.flush();
    assert.equal(feishu.replies.length, 1);

    const second = outbox();
    await second.enqueue(reply("a"));
    await second.flush();
    assert.equal(feishu.replies.length, 1, "a sent key is not sent again after a restart");
    assert.deepEqual(feishu.texts, ["reply a"]);

    // Queued but unsent survives a restart too, and goes out once.
    const third = outbox();
    await third.enqueue(reply("b"));
    const fourth = outbox();
    await fourth.enqueue(reply("b"));
    await fourth.flush();
    assert.deepEqual(feishu.texts, ["reply a", "reply b"]);
  });

  it("keeps queue order, and per-conversation order across a failure", async () => {
    const box = outbox();
    await box.enqueue(reply("one", { conversation: "oc_a" }));
    await box.enqueue(reply("two", { conversation: "oc_b" }));
    await box.enqueue(reply("three", { conversation: "oc_a" }));
    // The first reply to oc_a fails once; oc_b is not held up by it.
    feishu.replyAnswer = (hit, n) =>
      hit.replyTo === "om_one" && n === 1
        ? { status: 503, body: {} }
        : { status: 200, body: { code: 0, data: { message_id: `om_${String(n)}` } } };
    await box.flush();
    assert.deepEqual(feishu.texts, ["reply one", "reply two"], "three waits behind one");

    clock += backoffMs(1);
    await box.flush();
    assert.deepEqual(feishu.texts, ["reply one", "reply two", "reply one", "reply three"]);
    assert.equal((await box.status()).sent, 3);
  });

  it("backs off 5s doubling to 300s, and reports a reply that keeps failing", async () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs),
      [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000],
    );
    const box = outbox();
    await box.enqueue(reply("slow"));
    await box.enqueue(reply("next"));
    feishu.replyAnswer = (hit) =>
      hit.replyTo === "om_slow" ? { status: 429, body: {} } : { status: 200, body: { code: 0 } };

    await box.flush();
    assert.equal(feishu.replies.length, 1);
    // Not due yet: nothing is sent, and `next` still waits behind it.
    clock += 4_999;
    await box.flush();
    assert.equal(feishu.replies.length, 1);
    clock += 1;
    await box.flush();
    assert.equal(feishu.replies.length, 2);
    assert.equal((await box.status()).problems.length, 0, "two failures are not a problem yet");

    clock += 10_000;
    await box.flush();
    // Third failure: a problem now, and no longer holding its conversation.
    const status = await box.status();
    assert.equal(status.problems.length, 1);
    assert.equal(status.problems[0]?.key, "slow");
    assert.equal(status.problems[0]?.failures, 3);
    assert.match(status.problems[0]?.error ?? "", /HTTP 429/);
    assert.deepEqual(
      feishu.replies.map((hit) => hit.replyTo),
      ["om_slow", "om_slow", "om_slow", "om_next"],
    );

    // Still retried, and sent once Feishu recovers.
    feishu.reset();
    clock += 20_000;
    await box.flush();
    assert.deepEqual(feishu.texts, ["reply slow"]);
    const done = await box.status();
    assert.deepEqual([done.queued, done.sent, done.problems.length], [0, 2, 0]);
  });

  it("drops a reply whose target is gone, records why, and moves on", async () => {
    const box = outbox();
    await box.enqueue(reply("recalled"));
    await box.enqueue(reply("after"));
    feishu.replyAnswer = (hit) =>
      hit.replyTo === "om_recalled" ? refusal(230011) : { status: 200, body: { code: 0 } };
    await box.flush();

    assert.deepEqual(feishu.texts, ["reply recalled", "reply after"]);
    const status = await box.status();
    assert.deepEqual([status.queued, status.sent, status.dropped], [0, 1, 1]);
    assert.equal(status.drops[0]?.key, "recalled");
    assert.equal(status.drops[0]?.at, new Date(clock).toISOString());
    assert.match(status.drops[0]?.reason ?? "", /recalled \(code 230011\)/);

    // A dropped key is never retried or re-queued.
    await box.enqueue(reply("recalled"));
    await box.flush();
    assert.equal(feishu.replies.length, 2);
  });

  it("retries a refusal an administrator can fix", async () => {
    const box = outbox();
    await box.enqueue(reply("muted"));
    feishu.replyAnswer = () => refusal(230027);
    await box.flush();
    const status = await box.status();
    assert.deepEqual([status.queued, status.dropped], [1, 0]);
  });

  it("prunes sent and dropped records after 14 days", async () => {
    const box = outbox();
    await box.enqueue(reply("old"));
    await box.flush();
    assert.equal((await readdir(join(stateDir, "outbox"))).length, 1);

    clock += OUTBOX_RETENTION_MS + 1;
    await box.flush();
    assert.deepEqual(await readdir(join(stateDir, "outbox")), []);
    // Forgotten after the window: a rescan that finds it again would send it again.
    await box.enqueue(reply("old"));
    await box.flush();
    assert.equal(feishu.replies.length, 2);
  });

  it("continues the sequence after a restart", async () => {
    const box = outbox();
    await box.enqueue(reply("a"));
    await box.enqueue(reply("b"));
    await box.flush();
    const restarted = outbox();
    await restarted.enqueue(reply("c"));
    const names = (await readdir(join(stateDir, "outbox"))).sort();
    assert.deepEqual(names, ["000000000001.json", "000000000002.json", "000000000003.json"]);
  });

  it("stops between replies when the signal aborts", async () => {
    const box = outbox();
    await box.enqueue(reply("a", { conversation: "oc_a" }));
    await box.enqueue(reply("b", { conversation: "oc_b" }));
    const controller = new AbortController();
    feishu.replyAnswer = () => {
      controller.abort();
      return { status: 200, body: { code: 0 } };
    };
    await box.flush(controller.signal);
    assert.equal(feishu.replies.length, 1);
    assert.equal((await box.status()).queued, 1);
  });
});

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
