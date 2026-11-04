/**
 * A fake Feishu open platform on loopback, for the intake tests.
 *
 * Serves the tenant token, bot info, chat info, and chat messages with
 * `start_time` filtering and paging, as `im/v1/messages` does. A test adds
 * messages, and can make any path fail with a status and code for a while.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { FeishuMessageItem } from "../src/feishu/source.ts";

export const BOT = "ou_bot";
export const APP = "cli_test";

export interface Hit {
  path: string;
  query: URLSearchParams;
}

export interface Failure {
  status: number;
  code: number;
  /** How many calls fail before the path answers again. */
  times: number;
}

export class FakeFeishu {
  hits: Hit[] = [];
  /** Messages per chat id, in any order. */
  messages = new Map<string, FeishuMessageItem[]>();
  chats = new Map<string, { name: string; chat_mode: string }>();
  failures = new Map<string, Failure>();
  pageSize: number | null = null;
  /** Replies the bot posted, in arrival order. */
  replies: { replyTo: string; text: string; uuid: string }[] = [];
  private server: Server | null = null;
  private seq = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (raw += chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        this.hits.push({ path: url.pathname, query: url.searchParams });
        const reply = this.answer(url, raw);
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.hits = [];
    this.messages.clear();
    this.chats.clear();
    this.failures.clear();
    this.pageSize = null;
    this.replies = [];
  }

  calls(path: string): Hit[] {
    return this.hits.filter((hit) => hit.path === path);
  }

  /** Add one message and return it. `ms` defaults to now. */
  add(
    chat: string,
    fields: Partial<FeishuMessageItem> & { text?: string; from?: string; app?: boolean },
  ): FeishuMessageItem {
    this.seq += 1;
    const { text, from, app, ...rest } = fields;
    const item: FeishuMessageItem = {
      message_id: `om_${String(this.seq).padStart(4, "0")}`,
      msg_type: "text",
      create_time: String(Date.now()),
      chat_id: chat,
      sender: {
        id: from ?? "ou_alice",
        id_type: "open_id",
        sender_type: app === true ? "app" : "user",
      },
      body: { content: JSON.stringify({ text: text ?? "hello" }) },
      ...rest,
    };
    const list = this.messages.get(chat) ?? [];
    list.push(item);
    this.messages.set(chat, list);
    return item;
  }

  private answer(url: URL, raw: string): { status: number; body: unknown } {
    const failure = this.failures.get(url.pathname);
    if (failure !== undefined && failure.times > 0) {
      failure.times -= 1;
      return { status: failure.status, body: { code: failure.code, msg: "fail" } };
    }
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      return {
        status: 200,
        body: { code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 },
      };
    }
    if (url.pathname === "/open-apis/bot/v3/info") {
      return {
        status: 200,
        body: { code: 0, msg: "ok", bot: { open_id: BOT, app_name: "Oguri", activate_status: 2 } },
      };
    }
    const reply = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(url.pathname);
    if (reply !== null) {
      const sent = JSON.parse(raw) as { content: string; uuid: string };
      this.replies.push({
        replyTo: decodeURIComponent(reply[1] ?? ""),
        text: (JSON.parse(sent.content) as { text: string }).text,
        uuid: sent.uuid,
      });
      const id = `om_reply_${String(this.replies.length)}`;
      return { status: 200, body: { code: 0, msg: "ok", data: { message_id: id } } };
    }
    const chat = /^\/open-apis\/im\/v1\/chats\/([^/]+)$/.exec(url.pathname);
    if (chat !== null) {
      const info = this.chats.get(decodeURIComponent(chat[1] ?? ""));
      if (info === undefined) return { status: 400, body: { code: 232011, msg: "no chat" } };
      return { status: 200, body: { code: 0, msg: "ok", data: info } };
    }
    if (url.pathname === "/open-apis/im/v1/messages") {
      const id = url.searchParams.get("container_id") ?? "";
      const since = Number(url.searchParams.get("start_time") ?? "0") * 1000;
      const size = this.pageSize ?? Number(url.searchParams.get("page_size") ?? "50");
      const offset = Number(url.searchParams.get("page_token") ?? "0");
      const all = (this.messages.get(id) ?? [])
        .filter((m) => Number(m.create_time) >= since)
        .sort((a, b) => Number(a.create_time) - Number(b.create_time));
      const items = all.slice(offset, offset + size);
      const more = offset + size < all.length;
      return {
        status: 200,
        body: {
          code: 0,
          msg: "ok",
          data: { items, has_more: more, ...(more ? { page_token: String(offset + size) } : {}) },
        },
      };
    }
    return { status: 404, body: { code: 404, msg: "not found" } };
  }
}
