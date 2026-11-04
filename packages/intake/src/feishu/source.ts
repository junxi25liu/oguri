/**
 * Feishu as an intake source (ADR 0030): poll the configured chats as the
 * team's self-built app bot.
 *
 * Each chat has a read position: the `create_time` of the newest message
 * handled, in milliseconds, and the ids handled at exactly that millisecond.
 * Feishu's `start_time` is in whole seconds, so every poll re-reads part of a
 * second and the ids at the boundary are what keep a restart from replaying a
 * message or skipping its neighbour. A chat seen for the first time starts at
 * "now": history is never ingested.
 *
 * Direct messages are read only from chats the operator lists. Feishu offers no
 * call that lists a bot's p2p chats, so a listed chat whose `chat_mode` is
 * `p2p` is treated as direct.
 */

import type { FeishuIntakePolicy } from "@oguri/core";

import type { InboundMessage, IntakeSource, SourceHealth } from "../source.ts";
import { DEDUPE_WINDOW_MS, type ChatCursor, type IntakeStateData } from "../state.ts";
import { FeishuApiError, type FeishuClient } from "./client.ts";
import { parseContent, type FeishuMention } from "./content.ts";

/** One message as `im/v1/messages` lists it; only the fields intake reads. */
export interface FeishuMessageItem {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type: string;
  create_time: string;
  chat_id: string;
  deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: FeishuMention[];
}

/** A fetched message, before or after it became an `InboundMessage`. */
interface Fetched {
  ms: number;
  id: string;
  /** Null for a message intake never sees: deleted, or the app's own. */
  inbound: InboundMessage | null;
}

export interface FeishuSourceOptions {
  client: FeishuClient;
  policy: FeishuIntakePolicy;
  /** Shared with the caller, who persists it. The source keeps `botId`, `chats`, and `cursors` here. */
  state: IntakeStateData;
  now?: () => number;
  log?: (line: string) => void;
}

const PAGE_SIZE = 50;
/** Pages per chat per poll; the rest waits for the next poll. */
const MAX_PAGES = 10;
const MAX_BACKOFF_MS = 5 * 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Has this message been read already, by the chat's cursor? */
export function behindCursor(cursor: ChatCursor, ms: number, id: string): boolean {
  return ms < cursor.ms || (ms === cursor.ms && cursor.ids.includes(id));
}

/** Move a cursor past one message. Messages arrive in `create_time` order. */
export function advanceCursor(cursor: ChatCursor, ms: number, id: string): ChatCursor {
  if (ms > cursor.ms) return { ms, ids: [id] };
  if (ms === cursor.ms && !cursor.ids.includes(id)) return { ms, ids: [...cursor.ids, id] };
  return cursor;
}

/** A link that opens the chat in the Feishu or Lark client. */
export function chatLink(apiUrl: string | undefined, chatId: string): string {
  const host =
    apiUrl !== undefined && /larksuite\.com/.test(apiUrl)
      ? "applink.larksuite.com"
      : "applink.feishu.cn";
  return `https://${host}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

export class FeishuSource implements IntakeSource {
  readonly name = "feishu";
  private readonly client: FeishuClient;
  private readonly policy: FeishuIntakePolicy;
  private readonly state: IntakeStateData;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** What the last poll fetched, per chat, in order; consumed by `commit`. */
  private pending = new Map<string, Fetched[]>();
  private failures = 0;
  private backoffUntil = 0;
  private lastError: { at: string; message: string } | undefined;

  constructor(options: FeishuSourceOptions) {
    this.client = options.client;
    this.policy = options.policy;
    this.state = options.state;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  health(): SourceHealth {
    return {
      source: this.name,
      ...(this.state.botId === undefined ? {} : { botId: this.state.botId }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.backoffUntil > this.now() ? { backoffUntil: iso(this.backoffUntil) } : {}),
      chats: this.policy.chats.map((chat) => {
        const known = this.state.chats[chat.id];
        return {
          id: chat.id,
          ...(known?.mode === undefined ? {} : { mode: known.mode }),
          ...(known?.name === undefined ? {} : { name: known.name }),
        };
      }),
    };
  }

  /** The bot's open_id, fetched once and kept in the state. */
  async botId(): Promise<string> {
    if (this.state.botId !== undefined) return this.state.botId;
    const data = await this.client.call<{ bot?: { open_id?: string; app_name?: string } }>({
      method: "GET",
      path: "/open-apis/bot/v3/info",
    });
    const id = data.bot?.open_id;
    if (typeof id !== "string" || id.length === 0) {
      throw new FeishuApiError("feishu /open-apis/bot/v3/info: no bot open_id", null, 200);
    }
    this.state.botId = id;
    if (typeof data.bot?.app_name === "string") this.state.botName = data.bot.app_name;
    return id;
  }

  /** A chat's name and mode (`group`, `topic`, or `p2p`), fetched once. */
  async chatInfo(chatId: string): Promise<{ mode?: string; name?: string }> {
    const known = this.state.chats[chatId];
    if (known?.mode !== undefined) return known;
    const data = await this.client.call<{ chat_mode?: string; name?: string }>({
      method: "GET",
      path: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    });
    const info = {
      ...(typeof data.chat_mode === "string" ? { mode: data.chat_mode } : {}),
      ...(typeof data.name === "string" && data.name.length > 0 ? { name: data.name } : {}),
    };
    this.state.chats[chatId] = info;
    return info;
  }

  async poll(signal?: AbortSignal): Promise<InboundMessage[]> {
    this.pending = new Map();
    if (this.now() < this.backoffUntil) return [];
    const messages: InboundMessage[] = [];
    try {
      const botId = await this.botId();
      for (const chat of this.policy.chats) {
        if (signal?.aborted === true) break;
        try {
          const fetched = await this.fetchChat(chat.id, botId);
          this.pending.set(chat.id, fetched);
          for (const entry of fetched) if (entry.inbound !== null) messages.push(entry.inbound);
        } catch (error) {
          // One chat the bot was removed from must not silence the others.
          if (error instanceof FeishuApiError && error.transient) throw error;
          this.fail(error, false);
        }
      }
      this.failures = 0;
    } catch (error) {
      this.fail(error, error instanceof FeishuApiError && error.transient);
    }
    return messages;
  }

  async commit(handled: readonly InboundMessage[]): Promise<void> {
    const done = new Set(handled.map((message) => message.external.id));
    for (const [chatId, fetched] of this.pending) {
      let cursor = this.state.cursors[chatId];
      if (cursor === undefined) continue;
      for (const entry of fetched) {
        // Stop at the first message nobody handled: it and everything after it
        // in this chat come back next poll, so order within a chat holds.
        if (entry.inbound !== null && !done.has(entry.id)) break;
        cursor = advanceCursor(cursor, entry.ms, entry.id);
      }
      this.state.cursors[chatId] = cursor;
    }
    this.pending = new Map();
  }

  private fail(error: unknown, transient: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = { at: iso(this.now()), message };
    if (transient) {
      this.failures += 1;
      const delay = Math.min(
        MAX_BACKOFF_MS,
        this.policy.pollSeconds * 1000 * 2 ** Math.min(this.failures - 1, 10),
      );
      this.backoffUntil = this.now() + delay;
      this.log(`feishu: ${message}; retrying in ${String(Math.round(delay / 1000))}s`);
    } else {
      this.log(`feishu: ${message}`);
    }
  }

  private async fetchChat(chatId: string, botId: string): Promise<Fetched[]> {
    let cursor = this.state.cursors[chatId];
    if (cursor === undefined) {
      // First sight of this chat: begin now, and never read its history.
      cursor = { ms: this.now(), ids: [] };
      this.state.cursors[chatId] = cursor;
    } else if (cursor.ms < this.now() - DEDUPE_WINDOW_MS) {
      // Older than the window the dedupe set covers: reading it could relay a
      // message twice, so a long-stopped intake resumes at the window's edge.
      cursor = { ms: this.now() - DEDUPE_WINDOW_MS, ids: [] };
      this.state.cursors[chatId] = cursor;
    }
    const info = await this.chatInfo(chatId);
    const direct = info.mode === "p2p";
    const fetched: Fetched[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.client.call<{
        items?: FeishuMessageItem[];
        has_more?: boolean;
        page_token?: string;
      }>({
        method: "GET",
        path: "/open-apis/im/v1/messages",
        query: {
          container_id_type: "chat",
          container_id: chatId,
          start_time: Math.floor(cursor.ms / 1000),
          sort_type: "ByCreateTimeAsc",
          page_size: PAGE_SIZE,
          page_token: pageToken,
        },
      });
      for (const item of data.items ?? []) {
        const ms = Number(item.create_time);
        if (!Number.isFinite(ms) || behindCursor(cursor, ms, item.message_id)) continue;
        fetched.push({ ms, id: item.message_id, inbound: this.toInbound(item, botId, direct) });
      }
      if (data.has_more !== true || typeof data.page_token !== "string") break;
      pageToken = data.page_token;
    }
    fetched.sort((a, b) => a.ms - b.ms);
    return fetched;
  }

  private toInbound(
    item: FeishuMessageItem,
    botId: string,
    direct: boolean,
  ): InboundMessage | null {
    if (item.deleted === true) return null;
    const senderType = item.sender?.sender_type;
    const senderId = item.sender?.id;
    if (senderId === undefined || senderId.length === 0) return null;
    // The bot's own replies, by its app id or its open_id.
    if (senderId === this.policy.appId || senderId === botId) return null;
    const parsed = parseContent(
      item.msg_type,
      item.body?.content ?? "",
      item.mentions ?? [],
      botId,
    );
    const thread = item.thread_id ?? item.root_id;
    return {
      external: {
        source: this.name,
        id: item.message_id,
        conversation: item.chat_id,
        ...(thread === undefined || thread === "" ? {} : { thread }),
        actor: senderId,
        human: senderType === "user",
      },
      text: parsed.text,
      addressed: direct ? "direct" : parsed.mentionsBot ? "mention" : null,
      at: iso(Number(item.create_time)),
      ...(item.parent_id === undefined || item.parent_id === "" ? {} : { parent: item.parent_id }),
      ...(item.root_id === undefined || item.root_id === "" ? {} : { root: item.root_id }),
      url: chatLink(this.policy.apiUrl, item.chat_id),
    };
  }
}
