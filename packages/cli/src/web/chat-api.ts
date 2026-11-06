/**
 * The `/chat` HTTP API: one deliberate write, and reads that cannot write.
 *
 * This is not part of the dashboard's `/api/*` contract. The dashboard keeps
 * `ReadOnlyBackend` and GET/HEAD only; chat gets its own guarded `ChatBackend`
 * whose only reachable methods are the ones `ChatService` calls. A request from
 * a web page carries a custom header that a simple cross-site form cannot set,
 * an origin that must be this server, a loopback Host, and the bearer token
 * when one was configured. Nothing here accepts a room, a backend method, a
 * shell command, or an arbitrary mention.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { MachineRow } from "@oguri/core";
import { describeError } from "@oguri/core";

import { ChatService, type ChatBackend, type ChatTarget } from "../chat/service.ts";
import { assertChatRequest, assertChatTarget, chatTargets, chatThread } from "../chat/input.ts";
import { bearerMatches, hostName, isLoopbackHost, type BindPlan } from "./http.ts";
import { renderChatPage } from "./chat-page.ts";

/** A chat page's own reads and writes, never the dashboard's backend. */
export interface ChatSources {
  chat: ChatBackend;
  self: string;
  room: string;
}

/** The body cap is on the HTTP wire, before JSON parsing. */
export const CHAT_MAX_HTTP_BYTES = 24_000;

class ChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A tiny guard: every backend method this surface is allowed to reach. */
const CHAT_METHODS = new Set([
  "status",
  "roomJoin",
  "roomCreate",
  "send",
  "read",
  "sync",
  "machines",
  "presence",
]);

/** Wrap the write-capable Backend so no chat route can call anything else. */
export function chatBackend(source: ChatSources["chat"]): ChatBackend {
  return {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (!CHAT_METHODS.has(method)) {
        throw new Error(`chat cannot call '${method}'`);
      }
      return await source.call<T>(method, params);
    },
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown, head = false): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(head ? undefined : body);
}

function sendHtml(res: ServerResponse, html: string, nonce: string, head = false): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(head ? undefined : html);
}

/** A browser fetch sets a custom header; a plain cross-site form cannot. */
function explicitChatRequest(req: IncomingMessage): boolean {
  return req.headers["x-oguri-chat"] === "1";
}

/** The URL the person opened, without a token, used for Origin comparison. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = hostName(req);
  if (host === null) return false;
  if (origin !== undefined) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    const allowed = url.protocol === "http:" && url.hostname.toLowerCase() === host.toLowerCase();
    // A cross-site fetch that managed to set a custom header must still say so.
    return allowed && req.headers["sec-fetch-site"] !== "cross-site";
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin" && explicitChatRequest(req);
  // A non-browser client can omit both. The custom header still cannot be set
  // by a cross-site form, and loopback is the default bind.
  return explicitChatRequest(req) && isLoopbackHost(host);
}

/** Read a bounded request body. Oversized or stalled bodies are refused. */
async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > CHAT_MAX_HTTP_BYTES) {
    throw new ChatHttpError(413, "the request body is too large");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.length;
    if (size > CHAT_MAX_HTTP_BYTES) throw new ChatHttpError(413, "the request body is too large");
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface ChatOptions {
  plan: BindPlan;
  chat?: ChatSources;
  log?: (line: string) => void;
}

/** A route never runs until the handler has checked that chat is configured. */
type ReadyChatOptions = Omit<ChatOptions, "chat"> & {
  chat: ChatSources;
  guarded: ChatBackend;
};

function serviceFor(options: ReadyChatOptions): ChatService {
  return new ChatService({
    backend: options.guarded,
    self: options.chat.self,
    room: options.chat.room,
  });
}

function targetFrom(url: URL): ChatTarget {
  try {
    return assertChatTarget(url.searchParams.get("target") ?? "big");
  } catch (error) {
    throw new ChatHttpError(400, describeError(error));
  }
}

async function route(
  req: IncomingMessage,
  url: URL,
  options: ReadyChatOptions,
  body: string,
): Promise<{ status: number; value: unknown }> {
  const service = serviceFor(options);
  const path = url.pathname;
  if (path === "/chat/api/targets") {
    const machines = await options.guarded.call<MachineRow[]>("machines");
    return { status: 200, value: { targets: chatTargets(machines) } };
  }
  if (path === "/chat/api/history") {
    const target = targetFrom(url);
    const thread = chatThread(url.searchParams.get("thread"));
    const conversation = await service.history(target, thread === undefined ? {} : { thread });
    return { status: 200, value: conversation };
  }
  if (path === "/chat/api/send") {
    if (req.method !== "POST") throw new ChatHttpError(405, "send is a POST");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ChatHttpError(400, "invalid JSON");
    }
    let request;
    try {
      request = assertChatRequest(parsed);
    } catch (error) {
      throw new ChatHttpError(400, describeError(error));
    }
    // A crafted link cannot silently send a message under a different target.
    const queryTarget = targetFrom(url);
    if (queryTarget.value !== request.target.value) {
      throw new ChatHttpError(400, "the target in the body and the URL differ");
    }
    const queryThread = chatThread(url.searchParams.get("thread"));
    if (
      queryThread !== undefined &&
      request.thread !== undefined &&
      queryThread !== request.thread
    ) {
      throw new ChatHttpError(400, "the thread in the body and the URL differ");
    }
    const target = queryTarget;
    const thread = request.thread ?? queryThread;
    const sent = await service.send(target, request.body, thread);
    const conversation = await service.history(target, thread === undefined ? {} : { thread });
    const freshMessages = conversation.messages.some((message) => message.id === sent.id)
      ? conversation.messages
      : [...conversation.messages, { ...sent, state: "waiting" as const }];
    return {
      status: 200,
      value: {
        ...conversation,
        target,
        thread: conversation.thread ?? sent.thread ?? null,
        messages: freshMessages,
        waiting: true,
        timedOut: false,
      },
    };
  }
  throw new ChatHttpError(404, "not found");
}

/**
 * Handle `/chat` and `/chat/api/*`. Returns `true` when the request was one of
 * ours; the dashboard handler keeps every other path and its GET/HEAD rule.
 */
export function chatHandler(
  options: ChatOptions,
): (req: IncomingMessage, res: ServerResponse, head?: boolean) => boolean {
  const { plan } = options;
  const loopback = isLoopbackHost(plan.host);
  return (req, res, head = false): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/chat" && !url.pathname.startsWith("/chat/api/")) return false;
    const headOnly = head || req.method === "HEAD";

    const host = hostName(req);
    if (loopback && (host === null || !isLoopbackHost(host))) {
      sendJson(res, 421, { error: "chat answers only on loopback" }, headOnly);
      return true;
    }
    if (url.pathname === "/chat" && (req.method === "GET" || req.method === "HEAD")) {
      const nonce = randomBytes(16).toString("base64");
      sendHtml(res, renderChatPage(nonce), nonce, headOnly);
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
      sendJson(res, 405, { error: "GET, HEAD or POST only" }, headOnly);
      return true;
    }
    if (plan.token !== null && !bearerMatches(req.headers.authorization, plan.token)) {
      res.setHeader("www-authenticate", 'Bearer realm="oguri-chat"');
      sendJson(res, 401, { error: "a bearer token is required" }, headOnly);
      return true;
    }
    if (!explicitChatRequest(req)) {
      sendJson(res, 403, { error: "a chat request must come from this page" }, headOnly);
      return true;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: "a chat request must come from this page" }, headOnly);
      return true;
    }
    if (options.chat === undefined) {
      sendJson(res, 503, { error: "chat is not available on this server" }, headOnly);
      return true;
    }
    const ready: ReadyChatOptions = {
      plan,
      ...(options.log === undefined ? {} : { log: options.log }),
      chat: options.chat,
      guarded: chatBackend(options.chat.chat),
    };
    void readBody(req)
      .then((body) => route(req, url, ready, body))
      .then(
        ({ status, value }) => sendJson(res, status, value, headOnly),
        (error: unknown) => {
          const status =
            error instanceof ChatHttpError
              ? error.status
              : error instanceof TypeError || error instanceof RangeError
                ? 400
                : 500;
          if (status >= 500) options.log?.(`${url.pathname}: ${describeError(error)}`);
          sendJson(res, status, { error: describeError(error) }, headOnly);
        },
      );
    return true;
  };
}
