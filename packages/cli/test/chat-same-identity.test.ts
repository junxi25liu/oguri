/** Local chat and its superagent can legitimately share the same agent id. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMessage, ulid, type Message } from "@oguri/protocol";
import { FROM_SUPERAGENT_TAG, SMALL_REPORT_TAG, TO_BIG_TAG, TO_SMALL_TAG } from "@oguri/superagent";

import {
  chatMessage,
  ChatService,
  parseChatTarget,
  type ChatBackend,
} from "../src/chat/service.ts";

const SELF = "local-agent";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function fixture(): {
  chat: ChatService;
  messages: Message[];
  calls: string[];
  add: (input: Partial<Parameters<typeof createMessage>[0]> & { body: string }) => Message;
} {
  const messages: Message[] = [];
  const calls: string[] = [];
  const backend: ChatBackend = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      switch (method) {
        case "sync":
          return undefined as T;
        case "read":
          return messages as T;
        case "presence":
          return [{ id: SELF, status: "live" }] as T;
        default:
          throw new Error(`unexpected backend method ${method}`);
      }
    },
  };
  return {
    chat: new ChatService({ backend, self: SELF, room: "superagent", now: () => NOW }),
    messages,
    calls,
    add(input) {
      const created = createMessage({
        id: ulid(NOW + messages.length),
        from: SELF,
        room: "superagent",
        authorKind: "agent",
        kind: "msg",
        needs: "none",
        ts: new Date(NOW).toISOString(),
        ...input,
      });
      messages.push(created);
      return created;
    },
  };
}

describe("chat with a same-identity superagent", () => {
  it("classifies tagged replies as them while keeping local requests as you", () => {
    const { add } = fixture();
    const request = add({ body: "question", tags: [TO_BIG_TAG] });
    const reply = add({
      body: "answer",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
    });
    assert.equal(chatMessage(request, SELF).role, "you");
    assert.equal(chatMessage(reply, SELF).role, "them");
    assert.equal(chatMessage(reply, SELF).from, SELF);
  });

  it("shows a local Big reply without a redundant self-mention and stops waiting", async () => {
    const { chat, calls, add } = fixture();
    const request = add({ body: "你在吗说句话", tags: [TO_BIG_TAG] });
    assert.equal((await chat.history(parseChatTarget("big"))).waiting, true);
    const reply = add({
      body: "在。",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
      mentions: [],
    });
    const history = await chat.history(parseChatTarget("big"), { thread: request.header.thread });
    assert.deepEqual(
      history.messages.map((entry) => entry.body),
      ["你在吗说句话", "在。"],
    );
    assert.deepEqual(
      history.messages.map((entry) => entry.role),
      ["you", "them"],
    );
    assert.equal(history.messages[1]?.id, reply.header.id);
    assert.equal(history.waiting, false);
    assert.equal(history.timedOut, false);
    assert.equal(calls.includes("send"), false);
  });

  it("keeps local Small replies visible without accepting a different Small", async () => {
    const { chat, add } = fixture();
    const request = add({ body: "local small", tags: [TO_SMALL_TAG], mentions: [SELF] });
    add({
      body: "wrong small",
      from: "remote-agent",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
      mentions: [SELF],
    });
    add({
      body: "local answer",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
    });
    const history = await chat.history(parseChatTarget(SELF));
    assert.deepEqual(
      history.messages.map((entry) => entry.body),
      ["local small", "local answer"],
    );
    assert.equal(history.messages[1]?.role, "them");
    assert.equal(history.waiting, false);
    assert.deepEqual((await chat.history(parseChatTarget("big"))).messages, []);
  });

  it("follows a linked local late reply into a new thread without requiring self-mentions", async () => {
    const { chat, add } = fixture();
    const request = add({ body: "question", tags: [TO_BIG_TAG] });
    const late = add({
      body: "late answer",
      tags: [FROM_SUPERAGENT_TAG],
      inReplyTo: request.header.id,
      mentions: [],
    });
    add({
      body: "unrelated local reply",
      tags: [FROM_SUPERAGENT_TAG],
      inReplyTo: ulid(NOW - 1),
      mentions: [],
    });
    const history = await chat.history(parseChatTarget("big"));
    assert.deepEqual(
      history.messages.map((entry) => entry.body),
      ["question", "late answer"],
    );
    assert.equal(history.messages[1]?.role, "them");
    assert.equal(history.thread, late.header.thread);
    assert.equal(history.waiting, false);
    assert.equal(history.timedOut, false);
    const thread = await chat.history(parseChatTarget("big"), { thread: late.header.thread });
    assert.deepEqual(
      thread.messages.map((entry) => entry.body),
      ["late answer"],
    );
  });

  it("does not expose same-identity replies to someone else's request or worker reports", async () => {
    const { chat, add } = fixture();
    const request = add({ body: "mine", tags: [TO_BIG_TAG] });
    const other = add({
      body: "someone else's request",
      from: "other-agent",
      tags: [TO_BIG_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
    });
    add({
      body: "someone else's answer",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: other.header.id,
      mentions: ["other-agent"],
    });
    add({
      body: "worker report",
      tags: [FROM_SUPERAGENT_TAG, SMALL_REPORT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
    });
    add({
      body: "mine answered",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
    });
    const history = await chat.history(parseChatTarget("big"));
    assert.deepEqual(
      history.messages.map((entry) => entry.body),
      ["mine", "mine answered"],
    );
    assert.equal(history.waiting, false);
  });

  it("returns the actual local answer from terminal wait without sending again", async () => {
    const { chat, calls, add } = fixture();
    const request = add({ body: "question", tags: [TO_BIG_TAG] });
    add({
      body: "answer",
      tags: [FROM_SUPERAGENT_TAG],
      thread: request.header.thread,
      inReplyTo: request.header.id,
    });
    const history = await chat.waitForReply(parseChatTarget("big"), request.header.id, {
      timeoutMs: 0,
    });
    assert.deepEqual(
      history.messages.map((entry) => entry.body),
      ["question", "answer"],
    );
    assert.equal(history.messages[1]?.role, "them");
    assert.equal(history.waiting, false);
    assert.equal(history.timedOut, false);
    assert.equal(calls.includes("send"), false);
  });
});
