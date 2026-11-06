/**
 * Shared `ChatService` behaviour: real protocol messages in, one immutable
 * conversation out. No server, no socket, no timers beyond an injected sleeper.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMessage, ulid, type Message } from "@oguri/protocol";
import { FROM_SUPERAGENT_TAG, SMALL_REPORT_TAG, TO_BIG_TAG, TO_SMALL_TAG } from "@oguri/superagent";

import {
  assertChatBody,
  ChatService,
  isThreadId,
  parseChatTarget,
  type ChatBackend,
} from "../src/chat/service.ts";
import { chatTargets, assertChatRequest } from "../src/chat/input.ts";

const SELF = "alice-cursor";
const BIG = "big-superagent";
const SMALL = "small-1";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function message(
  input: Partial<Parameters<typeof createMessage>[0]> & { id: string; from: string; body: string },
): Message {
  return createMessage({
    room: "superagent",
    authorKind: "agent",
    kind: "msg",
    needs: "none",
    ts: new Date(NOW).toISOString(),
    ...input,
  });
}

function fakeBackend(
  messages: Message[],
  calls: { method: string; params?: Record<string, unknown> }[] = [],
): ChatBackend & { messages: Message[] } {
  const state = { messages };
  return {
    get messages() {
      return state.messages;
    },
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, ...(params === undefined ? {} : { params }) });
      switch (method) {
        case "status":
          return { subscriptions: ["superagent"] } as T;
        case "machines":
          return [
            {
              id: "machine-a",
              label: "Machine A",
              humans: [],
              contested: false,
              self: false,
              live: 1,
              agents: [{ id: SMALL }],
            },
          ] as T;
        case "presence":
          return [{ id: SMALL, status: "live" }] as T;
        case "sync":
          return undefined as T;
        case "read":
          return state.messages as T;
        case "send": {
          const input = (params?.["input"] ?? {}) as Record<string, unknown>;
          const created = message({
            id: ulid(NOW + calls.length),
            from: SELF,
            body: `${String(input["body"] ?? "")}\n`,
            ...(typeof input["thread"] === "string"
              ? { thread: input["thread"] }
              : typeof input["inReplyTo"] === "string"
                ? { thread: input["inReplyTo"] }
                : {}),
            ...(typeof input["inReplyTo"] === "string" ? { inReplyTo: input["inReplyTo"] } : {}),
            mentions: Array.isArray(input["mentions"]) ? (input["mentions"] as string[]) : [],
            tags: Array.isArray(input["tags"]) ? (input["tags"] as string[]) : [],
          });
          state.messages.push(created);
          return created as T;
        }
        default:
          throw new Error(`unexpected backend method ${method}`);
      }
    },
  } as ChatBackend & { messages: Message[] };
}

function service(
  messages: Message[] = [],
  calls: { method: string; params?: Record<string, unknown> }[] = [],
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): { service: ChatService; backend: ReturnType<typeof fakeBackend>; calls: typeof calls } {
  const backend = fakeBackend(messages, calls);
  return {
    service: new ChatService({
      backend,
      self: SELF,
      room: "superagent",
      now: options.now ?? (() => NOW),
      sleep: options.sleep ?? (async () => undefined),
      sync: true,
    }),
    backend,
    calls,
  };
}

describe("chat targets and input", () => {
  it("defaults to big and accepts exactly the routable target forms", () => {
    assert.equal(parseChatTarget(null).kind, "big");
    assert.equal(parseChatTarget("machine:machine-a").kind, "small");
    assert.equal(parseChatTarget("small-1").kind, "small");
    assert.throws(() => parseChatTarget("../../etc"), /target must be/);
    assert.throws(() => assertChatRequest({ target: "big", body: "x", shell: "rm" }), /shell/);
    assert.equal(assertChatRequest({ target: "big", body: "  hi  ", thread: null }).body, "hi");
    assert.equal(isThreadId("01ARZ3NDEKTSV4RRFFQ69G5FAW"), true);
    assert.equal(isThreadId("/etc/passwd"), false);
    assert.throws(() => assertChatBody("x".repeat(16_001)), /too long/);
  });

  it("offers Big, machine tokens, and each concrete agent", () => {
    const targets = chatTargets([
      {
        id: "machine-a",
        label: "Machine A",
        humans: [],
        contested: false,
        self: false,
        live: 1,
        agents: [{ id: SMALL }],
      },
    ] as never);
    assert.deepEqual(
      targets.map((t) => t.value),
      ["big", "machine:machine-a", SMALL],
    );
  });
});

describe("ChatService conversations", () => {
  it("sends to Big, keeps the transport thread, and never resends on a read", async () => {
    const { service: chat, calls } = service();
    const sent = await chat.send(parseChatTarget("big"), "第一句：你好");
    assert.equal(sent.role, "you");
    assert.equal(sent.thread, sent.id);
    const history = await chat.history(parseChatTarget("big"));
    assert.deepEqual(
      history.messages.map((m) => m.body),
      ["第一句：你好"],
    );
    assert.equal(history.waiting, true);
    assert.equal(history.timedOut, false);
    assert.equal(history.thread, sent.id);
    const sendsBefore = calls.filter((c) => c.method === "send").length;
    await chat.history(parseChatTarget("big"));
    assert.equal(calls.filter((c) => c.method === "send").length, sendsBefore);
    const write = calls.find((c) => c.method === "send")?.params?.["input"];
    assert.deepEqual((write as { tags: string[] }).tags, [TO_BIG_TAG]);
  });

  it("keeps a follow-up in one thread and makes it a real request", async () => {
    const { service: chat, calls } = service();
    const first = await chat.send(parseChatTarget("big"), "第一句：你好");
    const second = await chat.send(parseChatTarget("big"), "继续说中文", first.thread);
    assert.equal(second.thread, first.thread);
    assert.equal(second.inReplyTo, first.thread);
    assert.deepEqual(
      (await chat.history(parseChatTarget("big"))).messages.map((m) => m.body),
      ["第一句：你好", "继续说中文"],
    );
    const writes = calls.filter((c) => c.method === "send").map((c) => c.params?.["input"]);
    assert.equal((writes[0] as Record<string, unknown>)["inReplyTo"], undefined);
    assert.equal((writes[1] as Record<string, unknown>)["inReplyTo"], first.thread);
    assert.equal((writes[1] as Record<string, unknown>)["thread"], undefined);
  });

  it("shows a late reply and a reply in a new thread, and stops waiting", async () => {
    const rootId = ulid(NOW);
    const root = message({
      id: rootId,
      from: SELF,
      body: "question\n",
      tags: [TO_BIG_TAG],
    });
    const answer = message({
      id: ulid(NOW + 1),
      from: BIG,
      body: "answer\n",
      thread: rootId,
      inReplyTo: rootId,
      tags: [FROM_SUPERAGENT_TAG],
      mentions: [],
    });
    const newThreadId = ulid(NOW + 2);
    const late = message({
      id: newThreadId,
      from: BIG,
      body: "late answer\n",
      inReplyTo: rootId,
      tags: [FROM_SUPERAGENT_TAG],
      mentions: [SELF],
    });
    const { service: chat } = service([root, answer, late]);
    const history = await chat.history(parseChatTarget("big"));
    assert.deepEqual(
      history.messages.map((m) => m.body),
      ["question", "answer", "late answer"],
    );
    assert.equal(history.waiting, false);
    assert.equal(history.timedOut, false);
    assert.equal(history.messages[2]?.role, "them");
  });

  it("keeps one machine's history away from Big and another machine", async () => {
    const root = message({
      id: ulid(NOW),
      from: SELF,
      body: "for small\n",
      tags: [TO_SMALL_TAG],
      mentions: [SMALL, "machine:machine-a"],
    });
    const other = message({
      id: ulid(NOW + 1),
      from: SELF,
      body: "for big\n",
      tags: [TO_BIG_TAG],
    });
    const { service: chat } = service([root, other]);
    const small = await chat.history(parseChatTarget("machine:machine-a"));
    const big = await chat.history(parseChatTarget("big"));
    assert.deepEqual(
      small.messages.map((m) => m.body),
      ["for small"],
    );
    assert.deepEqual(
      big.messages.map((m) => m.body),
      ["for big"],
    );
    assert.equal(small.target.mention, SMALL);
    assert.equal(small.presence, "live");
    assert.deepEqual(
      (await chat.history(parseChatTarget("big"), { thread: root.header.thread })).messages,
      [],
      "a big deep link cannot show a small conversation",
    );
  });

  it("refuses an ambiguous machine instead of sending to several agents", async () => {
    const manyCalls: string[] = [];
    const many = new ChatService({
      backend: {
        async call<T>(method: string): Promise<T> {
          manyCalls.push(method);
          if (method === "machines") {
            return [
              {
                id: "machine-a",
                agents: [{ id: "small-1" }, { id: "small-2" }],
              },
            ] as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      self: SELF,
      room: "superagent",
    });
    await assert.rejects(
      many.send(parseChatTarget("machine:machine-a"), "hello"),
      /several agents \(small-1, small-2\)/,
    );
    assert.equal(manyCalls.filter((method) => method === "send").length, 0);
  });

  it("waits by reading only, and a Ctrl-C-like abort leaves the request readable", async () => {
    const { service: chat, calls } = service([], [], {
      now: (() => {
        let value = NOW;
        return () => (value += 1);
      })(),
    });
    const sent = await chat.send(parseChatTarget("big"), "still waiting");
    const controller = new AbortController();
    controller.abort();
    const timedOut = await chat.waitForReply(parseChatTarget("big"), sent.id, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    assert.equal(timedOut.waiting, true);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.messages[0]?.body, "still waiting");
    assert.equal(calls.filter((c) => c.method === "send").length, 1);
  });

  it("excludes worker reports and other people's replies", async () => {
    const root = message({
      id: ulid(NOW),
      from: SELF,
      body: "mine\n",
      tags: [TO_BIG_TAG],
    });
    const notice = message({
      id: ulid(NOW + 1),
      from: SMALL,
      body: "worker quiet\n",
      thread: root.header.thread,
      inReplyTo: root.header.id,
      tags: [FROM_SUPERAGENT_TAG, SMALL_REPORT_TAG],
      mentions: ["someone-else"],
    });
    const theirs = message({
      id: ulid(NOW + 2),
      from: "bob-codex",
      body: "not mine\n",
      tags: [TO_BIG_TAG],
    });
    const { service: chat } = service([root, notice, theirs]);
    assert.deepEqual(
      (await chat.history(parseChatTarget("big"))).messages.map((m) => m.body),
      ["mine"],
    );
  });
});
