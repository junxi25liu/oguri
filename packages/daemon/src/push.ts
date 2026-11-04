/**
 * Push notifications to a phone or a team chat (ADR 0028).
 *
 * The desktop notifier tells a person at the machine. This tells a person who
 * is away from it, through a channel they already carry: a Telegram bot, a
 * WeCom or Feishu group robot, a Feishu app bot that messages one person
 * directly, or any JSON webhook. Channels are configured in
 * the machine-local `policy.yaml`, because their URLs and tokens are
 * credentials.
 *
 * Three rules hold for every push:
 *  - **nothing secret leaves**: the body is scanned and dropped when flagged,
 *    and a log line never names the endpoint, which usually embeds its key;
 *  - **short**: room, sender, task id and title, and a trimmed excerpt;
 *  - **bounded**: a per-channel hourly cap, which urgent pushes bypass.
 */

import { createHmac } from "node:crypto";

import { hasSecrets, type PushChannel, type PushRule } from "@oguri/core";
import type { Message } from "@oguri/protocol";

import { type FeishuTokenCache, feishuApiBase, sendFeishuApp } from "./feishu-app.ts";

/** Every network send — push channels and the local webhook — gives up after this. */
export const PUSH_TIMEOUT_MS = 10_000;

/** Excerpt length. A push is a pointer to the inbox, not a copy of it. */
export const PUSH_EXCERPT_CHARS = 280;

const HOUR_MS = 60 * 60_000;

/** Why a push is being sent. `message` is any delivery a channel takes under `all`. */
export type PushReason = Exclude<PushRule, "all"> | "message" | "test";

export interface PushEvent {
  reason: PushReason;
  urgent: boolean;
  network: string;
  room: string;
  from: string;
  messageId: string;
  ts: string;
  task?: { id: string; title: string; state: string };
  /** Raw message body. Scanned and trimmed before it goes anywhere. */
  body: string;
}

/** Who this daemon delivers for: the rules depend on it. */
export interface PushSelf {
  agentId: string;
  machineId: string;
}

export interface PushResult {
  channel: string;
  ok: boolean;
  /** Set when the push was not sent because of the hourly cap. */
  limited?: boolean;
  error?: string;
}

/** The rules one delivered message matches, strongest first. `all` always matches. */
export function matchPushRules(message: Message, self: PushSelf): PushRule[] {
  const header = message.header;
  const rules: PushRule[] = [];
  if (header.needs === "human") rules.push("needs-human");
  const task = header.task;
  // Only for work this agent handed out: an assignee already knows how its
  // own task went, and a bystander did not ask.
  if (task !== undefined && task.creator === self.agentId && header.from !== self.agentId) {
    if (task.state === "blocked" || task.state === "stuck") rules.push("task-blocked");
    if (task.state === "completed") rules.push("task-completed");
  }
  if (
    header.mentions.includes(self.agentId) ||
    header.mentions.includes(`machine:${self.machineId}`)
  ) {
    rules.push("mentions");
  }
  rules.push("all");
  return rules;
}

/** Turn a delivered message into the event a channel would push, if any rule matches. */
export function pushEventFor(
  message: Message,
  network: string,
  self: PushSelf,
  rules: readonly PushRule[] = matchPushRules(message, self),
): PushEvent {
  const header = message.header;
  const strongest = rules[0] ?? "all";
  return {
    reason: strongest === "all" ? "message" : strongest,
    urgent: header.needs === "human" || header.priority === "blocking",
    network,
    room: header.room,
    from: header.from,
    messageId: header.id,
    ts: header.ts,
    ...(header.task === undefined
      ? {}
      : { task: { id: header.task.id, title: header.task.title, state: header.task.state } }),
    body: message.body,
  };
}

/** Whether a channel subscribed to any of the rules a message matched. */
export function channelWants(channel: PushChannel, rules: readonly PushRule[]): boolean {
  return channel.events.some((event) => rules.includes(event));
}

/** Flatten, strip control characters, and cut to `max` characters. */
export function trimText(text: string, max: number): string {
  const flat = text
    .replace(/\s+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const TITLES: Record<PushReason, string> = {
  "needs-human": "Decision needed",
  "task-blocked": "Task blocked",
  "task-completed": "Task completed",
  mentions: "Mentioned",
  message: "New message",
  test: "Test notification",
};

/** The text every format is built from, after the secret scan. */
export interface PushText {
  title: string;
  /** `from …`, `task …` — fixed fields, one per line. */
  facts: string[];
  /** Trimmed body, or a note that it was withheld. Empty when there is no body. */
  excerpt: string;
  /** Task title after the same scan, for formats that carry it as a field. */
  taskTitle: string | null;
}

/**
 * Build the visible text, refusing to carry anything the scanner flags.
 *
 * The body is scanned whole, before trimming: a credential cut in half by the
 * excerpt would no longer match a rule, and half a key is still a leak.
 */
export function composePush(event: PushEvent): PushText {
  const title = `${TITLES[event.reason]} · #${event.room}`;
  const facts = [`from ${event.from}`];
  let taskTitle: string | null = null;
  if (event.task !== undefined) {
    taskTitle = hasSecrets(event.task.title)
      ? "(title withheld by the secret scanner)"
      : trimText(event.task.title, 120);
    facts.push(`task ${event.task.id} — ${taskTitle} [${event.task.state}]`);
  }
  const excerpt = hasSecrets(event.body)
    ? "(body withheld: the secret scanner flagged it; read it in the inbox)"
    : trimText(event.body, PUSH_EXCERPT_CHARS);
  return { title, facts, excerpt, taskTitle };
}

function plainText(text: PushText): string {
  return [text.title, ...text.facts, ...(text.excerpt === "" ? [] : ["", text.excerpt])].join("\n");
}

/**
 * Neutralise WeCom markdown in text that came from another machine.
 *
 * WeCom renders links, `<font>` tags and emphasis. A message body must not be
 * able to dress itself up as oguri's own line, or hide a link behind innocent
 * text, so the characters that start those constructs are swapped for
 * look-alikes that render literally.
 */
export function neutraliseMarkdown(text: string): string {
  return text
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\[/g, "⟦")
    .replace(/\]/g, "⟧")
    .replace(/[*`#_~]/g, " ");
}

interface Request {
  url: string;
  body: unknown;
}

/** Build the HTTP request for one channel. Exported for tests. */
export function buildPushRequest(
  channel: PushChannel,
  event: PushEvent,
  now = Date.now(),
): Request {
  const text = composePush(event);
  switch (channel.format) {
    case "wecom": {
      const lines = [
        `**${neutraliseMarkdown(text.title)}**`,
        ...text.facts.map((fact) => `> ${neutraliseMarkdown(fact)}`),
        ...(text.excerpt === "" ? [] : ["", neutraliseMarkdown(text.excerpt)]),
      ];
      return {
        url: channel.url ?? "",
        body: { msgtype: "markdown", markdown: { content: lines.join("\n") } },
      };
    }
    case "feishu": {
      const body: Record<string, unknown> = {
        msg_type: "text",
        content: { text: plainText(text) },
      };
      if (channel.secret !== undefined) {
        // Feishu's custom-bot signature: HMAC-SHA256 keyed by
        // "<timestamp>\n<secret>" over an empty message, base64.
        const timestamp = String(Math.floor(now / 1000));
        body["timestamp"] = timestamp;
        body["sign"] = createHmac("sha256", `${timestamp}\n${channel.secret}`)
          .update("")
          .digest("base64");
      }
      return { url: channel.url ?? "", body };
    }
    case "feishu-app": {
      // `content` is a JSON string inside the JSON body, as Feishu requires.
      const type = encodeURIComponent(channel.receiveIdType ?? "open_id");
      return {
        url: `${feishuApiBase(channel)}/open-apis/im/v1/messages?receive_id_type=${type}`,
        body: {
          receive_id: channel.receiveId,
          msg_type: "text",
          content: JSON.stringify({ text: plainText(text) }),
        },
      };
    }
    case "telegram": {
      const base = (channel.apiUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
      return {
        url: `${base}/bot${channel.token ?? ""}/sendMessage`,
        // No parse_mode: the text is plain, so a body cannot inject markup.
        body: { chat_id: channel.chatId, text: plainText(text), disable_web_page_preview: true },
      };
    }
    case "json":
      return {
        url: channel.url ?? "",
        body: {
          title: text.title,
          body: [...text.facts, ...(text.excerpt === "" ? [] : [text.excerpt])].join("\n"),
          urgent: event.urgent,
          event: event.reason,
          network: event.network,
          room: event.room,
          from: event.from,
          messageId: event.messageId,
          ts: event.ts,
          task: event.task === undefined ? null : { ...event.task, title: text.taskTitle ?? "" },
        },
      };
  }
}

/** Read the provider's own success flag; HTTP 200 alone does not mean delivered. */
function providerError(channel: PushChannel, payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (channel.format === "wecom" && typeof p["errcode"] === "number" && p["errcode"] !== 0) {
    return `wecom errcode ${String(p["errcode"])}`;
  }
  if (channel.format === "feishu") {
    const code = p["code"] ?? p["StatusCode"];
    if (typeof code === "number" && code !== 0) return `feishu code ${String(code)}`;
  }
  if (channel.format === "telegram" && p["ok"] === false) {
    return `telegram error ${String(p["error_code"] ?? "")}`.trim();
  }
  return null;
}

/**
 * Describe a send failure without the endpoint.
 *
 * The URL of a WeCom or Feishu robot, and the path of a Telegram call, contain
 * the credential. Only the error kind is kept.
 */
function describeSendError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `timed out after ${String(Math.round(timeoutMs / 1000))}s`;
    }
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause !== undefined && typeof cause.code === "string")
      return `${error.message} (${cause.code})`;
    return error.message;
  }
  return String(error);
}

/** Send one push. Never throws: the outcome is in the result. */
export async function sendPush(
  channel: PushChannel,
  event: PushEvent,
  options: { timeoutMs?: number; feishuTokens?: FeishuTokenCache } = {},
): Promise<PushResult> {
  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
  try {
    const request = buildPushRequest(channel, event);
    if (channel.format === "feishu-app") {
      const refused = await sendFeishuApp(channel, request, {
        timeoutMs,
        ...(options.feishuTokens === undefined ? {} : { tokens: options.feishuTokens }),
      });
      return refused === null
        ? { channel: channel.name, ok: true }
        : { channel: channel.name, ok: false, error: refused };
    }
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok)
      return { channel: channel.name, ok: false, error: `HTTP ${String(response.status)}` };
    let payload: unknown = null;
    try {
      payload = raw === "" ? null : JSON.parse(raw);
    } catch {
      payload = null;
    }
    const refused = providerError(channel, payload);
    return refused === null
      ? { channel: channel.name, ok: true }
      : { channel: channel.name, ok: false, error: refused };
  } catch (error) {
    return { channel: channel.name, ok: false, error: describeSendError(error, timeoutMs) };
  }
}

/**
 * A rolling one-hour window per channel.
 *
 * In memory: a restarted daemon starts a fresh window. That errs towards
 * delivering, and the cap exists to stop a flood, not to meter a quota.
 */
export class PushRateLimit {
  private readonly sent = new Map<string, number[]>();

  /** Record and allow, or refuse. Urgent pushes always pass, and still count. */
  take(channel: PushChannel, urgent: boolean, now = Date.now()): boolean {
    const recent = (this.sent.get(channel.name) ?? []).filter((at) => now - at < HOUR_MS);
    if (!urgent && recent.length >= channel.maxPerHour) {
      this.sent.set(channel.name, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(channel.name, recent);
    return true;
  }
}

export interface PushDispatcherOptions {
  /** Read on every delivery, so editing `policy.yaml` needs no restart. */
  loadChannels: () => Promise<PushChannel[]>;
  log: (message: string) => void;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Route delivered messages to the channels that asked for them.
 *
 * Sends run in the background: a slow chat API must not hold up the sync loop
 * that delivers the next message. `settled()` waits for them, for tests and
 * for `notify test`.
 */
export class PushDispatcher {
  private readonly options: PushDispatcherOptions;
  private readonly limit = new PushRateLimit();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: PushDispatcherOptions) {
    this.options = options;
  }

  /** Push what each channel subscribed to. Never throws. */
  deliver(network: string, self: PushSelf, messages: readonly Message[]): void {
    if (messages.length === 0) return;
    this.track(this.route(network, self, messages));
  }

  /** Wait for every push started so far. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled(this.inFlight);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.options.log(`push failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  private async route(
    network: string,
    self: PushSelf,
    messages: readonly Message[],
  ): Promise<PushResult[]> {
    let channels: PushChannel[];
    try {
      channels = await this.options.loadChannels();
    } catch (error) {
      this.options.log(
        `push skipped: policy unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    if (channels.length === 0) return [];

    const sends: Promise<PushResult>[] = [];
    for (const message of messages) {
      const rules = matchPushRules(message, self);
      const event = pushEventFor(message, network, self, rules);
      for (const channel of channels) {
        if (!channelWants(channel, rules)) continue;
        const now = this.options.now?.() ?? Date.now();
        if (!this.limit.take(channel, event.urgent, now)) {
          this.options.log(
            `push to ${channel.name} dropped: ${String(channel.maxPerHour)}/hour cap reached`,
          );
          sends.push(Promise.resolve({ channel: channel.name, ok: false, limited: true }));
          continue;
        }
        sends.push(this.sendLogged(channel, event));
      }
    }
    return await Promise.all(sends);
  }

  private async sendLogged(channel: PushChannel, event: PushEvent): Promise<PushResult> {
    const result = await sendPush(
      channel,
      event,
      this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
    );
    if (!result.ok) {
      this.options.log(`push to ${channel.name} failed: ${result.error ?? "unknown error"}`);
    }
    return result;
  }
}

/** The event `oguri notify test` sends. Urgent, so the hourly cap never hides it. */
export function testPushEvent(agentId: string, network: string): PushEvent {
  return {
    reason: "test",
    urgent: true,
    network,
    room: "oguri",
    from: agentId,
    messageId: "test",
    ts: new Date().toISOString(),
    body: "If you can read this, the channel works. oguri pushes needs-human requests and the outcome of tasks you created.",
  };
}
