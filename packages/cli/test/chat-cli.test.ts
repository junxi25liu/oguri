/**
 * `oguri chat`'s terminal loop: real immutable messages in, one conversation
 * out. No TTY, no timers, no daemon. The service's fake transport writes the
 * same headers the real `send` would resolve from `thread`/`inReplyTo`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMessage, ulid, type Message } from "@oguri/protocol";
import { FROM_SUPERAGENT_TAG, TO_SMALL_TAG } from "@oguri/superagent";

import { chatLoop } from "../src/commands/chat.ts";
import {
  ChatService,
  parseChatTarget,
  type ChatBackend,
  type ChatTarget,
} from "../src/chat/service.ts";

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

function transport(): {
  backend: ChatBackend;
  calls: { method: string; params?: Record<string, unknown> }[];
  messages: Message[];
  answer: (body: string, to: string, from?: string) => void;
} {
  const messages: Message[] = [];
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  let sequence = 0;
  const backend: ChatBackend = {
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
              agents: [{ id: SMALL }],
              humans: [],
              contested: false,
              self: false,
              live: 1,
            },
          ] as T;
        case "presence":
          return [{ id: SMALL, status: "live" }] as T;
        case "sync":
        case "roomJoin":
        case "roomCreate":
          return undefined as T;
        case "read":
          return messages as T;
        case "send": {
          const input = (params?.["input"] ?? {}) as Record<string, unknown>;
          const parent =
            typeof input["inReplyTo"] === "string" || typeof input["thread"] === "string"
              ? (input["inReplyTo"] ?? input["thread"])
              : undefined;
          sequence += 1;
          const created = message({
            id: ulid(NOW + sequence),
            from: SELF,
            body: `${String(input["body"] ?? "")}\n`,
            ...(parent === undefined
              ? {}
              : { inReplyTo: parent as string, thread: parent as string }),
            mentions: Array.isArray(input["mentions"]) ? (input["mentions"] as string[]) : [],
            tags: Array.isArray(input["tags"]) ? (input["tags"] as string[]) : [],
          });
          messages.push(created);
          return created as T;
        }
        default:
          throw new Error(`unexpected backend method ${method}`);
      }
    },
  };
  return {
    backend,
    calls,
    messages,
    answer(body, to, from = BIG) {
      sequence += 1;
      messages.push(
        message({
          id: ulid(NOW + sequence),
          from,
          body: `${body}\n`,
          inReplyTo: to,
          thread: messages.find((entry) => entry.header.id === to)?.header.thread ?? to,
          tags: [FROM_SUPERAGENT_TAG],
          mentions: [SELF],
        }),
      );
    },
  };
}

function io(lines: string[]): {
  io: Parameters<typeof chatLoop>[1];
  questions: string[];
  closed: () => boolean;
} {
  const questions: string[] = [];
  let isClosed = false;
  const queue = [...lines];
  return {
    questions,
    closed: () => isClosed,
    io: {
      async question(query: string): Promise<string> {
        questions.push(query);
        const next = queue.shift();
        if (next === undefined) throw new Error("EOF");
        return next;
      },
      close(): void {
        isClosed = true;
      },
    } as unknown as Parameters<typeof chatLoop>[1],
  };
}

function chat(transportState: ReturnType<typeof transport>): ChatService {
  return new ChatService({
    backend: transportState.backend,
    self: SELF,
    room: "superagent",
    now: () => NOW,
    sleep: async () => undefined,
    sync: true,
  });
}

describe("oguri chat terminal loop", () => {
  it("keeps Chinese multi-turn input in one thread and shows a real reply once", async () => {
    const state = transport();
    const lines: string[] = [];
    const stream = io(["第一句：你好", "/history", "再说一句", "/exit"]);
    const service = chat(state);
    const originalSend = service.send.bind(service);
    service.send = async (target: ChatTarget, body: string, thread?: string) => {
      const sent = await originalSend(target, body, thread);
      state.answer(`回答：${body}`, sent.id);
      return sent;
    };
    assert.equal(
      await chatLoop(service, stream.io, {
        target: parseChatTarget("big"),
        isTty: false,
        waitMs: 0,
        write: (line) => lines.push(line),
      }),
      0,
    );
    assert.deepEqual(stream.questions, ["", "", "", ""]);
    const writes = state.calls.filter((call) => call.method === "send");
    assert.equal(writes.length, 2, "one write per deliberate Enter");
    const second = writes[1]?.params?.["input"] as Record<string, unknown>;
    assert.equal(second["inReplyTo"], writes[0] ? (state.messages[0]?.header.id ?? "") : "");
    assert.equal(second["thread"], undefined);
    assert.ok(lines.some((line) => line.includes("第一句：你好")));
    assert.ok(lines.some((line) => line.includes("再说一句")));
    assert.equal(
      lines.filter((line) => line.includes("回答：第一句：你好")).length,
      1,
      "a refresh does not duplicate an answer",
    );
    assert.equal(stream.closed(), false, "the loop exits without closing an owned readline");
  });

  it("switches from Big to one machine's Small and never mixes the histories", async () => {
    const state = transport();
    const lines: string[] = [];
    const stream = io(["/target machine:machine-a", "和这台机器说话", "/exit"]);
    const service = chat(state);
    const originalSend = service.send.bind(service);
    service.send = async (target: ChatTarget, body: string, thread?: string) => {
      const sent = await originalSend(target, body, thread);
      state.answer(`small: ${body}`, sent.id, SMALL);
      return sent;
    };
    await chatLoop(service, stream.io, {
      target: parseChatTarget("big"),
      isTty: false,
      waitMs: 0,
      write: (line) => lines.push(line),
    });
    const writes = state.calls.filter((call) => call.method === "send");
    const sent = writes[0]?.params?.["input"] as Record<string, unknown>;
    assert.deepEqual(sent["tags"], [TO_SMALL_TAG]);
    assert.deepEqual(sent["mentions"], [SMALL]);
    assert.ok(lines.some((line) => line.includes("switched to machine:machine-a")));
    assert.ok(lines.some((line) => line.includes("small: 和这台机器说话")));
    const big = await service.history(parseChatTarget("big"));
    const small = await service.history(parseChatTarget("machine:machine-a"));
    assert.deepEqual(big.messages, []);
    assert.deepEqual(
      small.messages.map((entry) => entry.body),
      ["和这台机器说话", "small: 和这台机器说话"],
    );
  });

  it("keeps slash commands local, sends a literal //, and accepts EOF", async () => {
    const state = transport();
    const lines: string[] = [];
    const stream = io(["/help", "/targets", "//literal", "/quit"]);
    const service = chat(state);
    const originalSend = service.send.bind(service);
    service.send = async (target: ChatTarget, body: string, thread?: string) => {
      const sent = await originalSend(target, body, thread);
      state.answer("ack", sent.id);
      return sent;
    };
    assert.equal(
      await chatLoop(service, stream.io, {
        target: parseChatTarget("big"),
        isTty: false,
        waitMs: 0,
        targets: async () => [parseChatTarget("big"), parseChatTarget("machine:machine-a")],
        write: (line) => lines.push(line),
      }),
      0,
    );
    const writes = state.calls.filter((call) => call.method === "send");
    assert.equal(writes.length, 1);
    const firstWrite = writes[0];
    assert.ok(firstWrite !== undefined);
    const firstInput = firstWrite.params?.["input"];
    assert.ok(firstInput !== undefined);
    assert.equal((firstInput as Record<string, unknown>)["body"], "/literal");
    assert.ok(lines.some((line) => line.includes("/exit")));
    assert.ok(lines.some((line) => line.includes("machine:machine-a")));
  });

  it("an EOF ends only this terminal and keeps every sent message readable", async () => {
    const state = transport();
    const stream = io([]);
    const service = chat(state);
    assert.equal(
      await chatLoop(service, stream.io, {
        target: parseChatTarget("big"),
        isTty: false,
        write: () => undefined,
      }),
      0,
    );
    assert.equal(state.calls.filter((call) => call.method === "send").length, 0);
  });

  it("an interrupted wait leaves the request visible and sends nothing twice", async () => {
    const state = transport();
    const lines: string[] = [];
    const stream = io(["no answer yet", "/exit"]);
    const service = chat(state);
    const waitStates: boolean[] = [];
    const originalWait = service.waitForReply.bind(service);
    service.waitForReply = async (target, requestId, options) => {
      const controller = new AbortController();
      controller.abort();
      return await originalWait(target, requestId, { ...options, signal: controller.signal });
    };
    assert.equal(
      await chatLoop(service, stream.io, {
        target: parseChatTarget("big"),
        isTty: false,
        waitMs: 60_000,
        write: (line) => lines.push(line),
        onWait: (value) => waitStates.push(value),
      }),
      0,
    );
    assert.deepEqual(waitStates, [true, false]);
    assert.equal(state.calls.filter((call) => call.method === "send").length, 1);
    const history = await service.history(parseChatTarget("big"));
    assert.deepEqual(
      history.messages.map((entry) => entry.body),
      ["no answer yet"],
    );
    assert.equal(history.waiting, true);
    assert.ok(lines.some((line) => line.includes("no reply yet")));
  });

  it("shows a failed send and recovers, without writing anything on failure", async () => {
    const state = transport();
    const lines: string[] = [];
    const stream = io(["one", "two", "/exit"]);
    const service = chat(state);
    const originalSend = service.send.bind(service);
    let refused = true;
    service.send = async (target: ChatTarget, body: string, thread?: string) => {
      if (refused) {
        refused = false;
        throw new Error("transport is offline");
      }
      const sent = await originalSend(target, body, thread);
      state.answer("recovered", sent.id);
      return sent;
    };
    await chatLoop(service, stream.io, {
      target: parseChatTarget("big"),
      isTty: false,
      waitMs: 0,
      write: (line) => lines.push(line),
    });
    assert.equal(state.calls.filter((call) => call.method === "send").length, 1);
    assert.ok(lines.some((line) => line.includes("could not send: transport is offline")));
    assert.ok(lines.some((line) => line.includes("nothing was written")));
    assert.ok(lines.some((line) => line.includes("recovered")));
    assert.deepEqual(
      (await service.history(parseChatTarget("big"))).messages.map((entry) => entry.body),
      ["two", "recovered"],
    );
  });
});
