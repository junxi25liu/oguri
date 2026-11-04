/**
 * The `notifications` section of the machine-local policy (ADR 0028).
 *
 * Push channels carry credentials — a WeCom or Feishu webhook URL embeds its
 * key, a Telegram bot token is the whole bot, a Feishu app secret mints tokens
 * for the whole app — so they live in `policy.yaml`,
 * the file oguri reads and never writes or publishes. `config.yaml` is
 * rewritten by the tool, and the transport repository is shared with everyone.
 *
 * Kept out of `policy.ts` itself so the section can grow without touching the
 * approval and worker grammar beside it.
 */

/**
 * How a channel's request is shaped. `json` is the generic webhook.
 *
 * `feishu` is a group's custom-bot webhook. `feishu-app` is a Feishu (Lark)
 * self-built app's bot, which can message one person directly: a webhook bot
 * can only post to the group it was added to.
 */
export const PUSH_FORMATS = ["json", "wecom", "feishu", "feishu-app", "telegram"] as const;
export type PushFormat = (typeof PUSH_FORMATS)[number];

/** Who a `feishu-app` message goes to, in Feishu's own `receive_id_type` terms. */
export const FEISHU_RECEIVE_ID_TYPES = [
  "open_id",
  "user_id",
  "union_id",
  "email",
  "chat_id",
] as const;
export type FeishuReceiveIdType = (typeof FEISHU_RECEIVE_ID_TYPES)[number];

/** Which arrivals a channel pushes. */
export const PUSH_RULES = [
  "needs-human",
  "task-completed",
  "task-blocked",
  "mentions",
  "all",
] as const;
export type PushRule = (typeof PUSH_RULES)[number];

/**
 * What a channel pushes when it names no `events`.
 *
 * The three things a person away from the keyboard acts on: a decision only
 * they can make, and the outcome of work they handed out. Mentions and
 * ordinary traffic are opt-in, because a phone that buzzes for chatter is a
 * phone that gets muted.
 */
export const DEFAULT_PUSH_RULES: readonly PushRule[] = [
  "needs-human",
  "task-completed",
  "task-blocked",
];

/** Pushes per channel per rolling hour. Urgent ones always pass. */
export const DEFAULT_PUSH_PER_HOUR = 30;

export interface PushChannel {
  name: string;
  format: PushFormat;
  /** Endpoint for `json`, `wecom` and `feishu`. Often embeds the key. */
  url?: string;
  /** Feishu signing secret, when the bot has signature verification on. */
  secret?: string;
  /** Telegram bot token. */
  token?: string;
  /** Telegram chat id. Numeric ids are kept as strings. */
  chatId?: string;
  /**
   * API base. Telegram defaults to https://api.telegram.org; `feishu-app`
   * defaults to https://open.feishu.cn, or https://open.larksuite.com for Lark.
   * Tests point it locally.
   */
  apiUrl?: string;
  /** `feishu-app`: the app's App ID (cli_...). */
  appId?: string;
  /** `feishu-app`: the App Secret. Exchanged for a short-lived tenant token. */
  appSecret?: string;
  /** `feishu-app`: how `receiveId` is read. */
  receiveIdType?: FeishuReceiveIdType;
  /** `feishu-app`: the person (or chat) to message. */
  receiveId?: string;
  events: PushRule[];
  maxPerHour: number;
}

export interface NotificationPolicy {
  channels: PushChannel[];
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = { channels: [] };

const CHANNEL_KEYS = [
  "format",
  "url",
  "secret",
  "token",
  "chatId",
  "apiUrl",
  "appId",
  "appSecret",
  "receiveIdType",
  "receiveId",
  "events",
  "maxPerHour",
] as const;

/** Keys each format takes besides `format`, `events` and `maxPerHour`. */
const FORMAT_KEYS: Record<PushFormat, readonly string[]> = {
  json: ["url"],
  wecom: ["url"],
  feishu: ["url", "secret"],
  "feishu-app": ["appId", "appSecret", "receiveIdType", "receiveId", "apiUrl"],
  telegram: ["token", "chatId", "apiUrl"],
};

/** Channel names appear in `--channel` and in logs; keep them plain. */
const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function httpUrl(value: unknown, name: string, source: string): string {
  if (typeof value !== "string" || value.length === 0) fail(source, `${name} must be a URL`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Never echo the value: it usually carries the channel's key.
    fail(source, `${name} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(source, `${name} must be an http or https URL`);
  }
  return value;
}

function nonEmpty(value: unknown, name: string, source: string): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(source, `${name} must be a non-empty string`);
  }
  return value.trim();
}

/** Parse `notifications:`, refusing anything it does not understand. */
export function parseNotificationPolicy(value: unknown, source: string): NotificationPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "'notifications' must be a mapping");
  }
  const section = value as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (key !== "channels") {
      fail(source, `unknown key 'notifications.${key}'; known keys: channels`);
    }
  }
  const channelsValue = section["channels"] ?? {};
  if (channelsValue === null || typeof channelsValue !== "object" || Array.isArray(channelsValue)) {
    fail(source, "notifications.channels must be a mapping of name to channel");
  }

  const channels: PushChannel[] = [];
  for (const [name, raw] of Object.entries(channelsValue as Record<string, unknown>)) {
    const at = `notifications.channels.${name}`;
    if (!CHANNEL_NAME.test(name)) {
      fail(source, `${at}: invalid channel name; use lowercase letters, digits, -`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail(source, `${at} must be a mapping`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!(CHANNEL_KEYS as readonly string[]).includes(key)) {
        fail(source, `unknown key '${at}.${key}'; known keys: ${CHANNEL_KEYS.join(", ")}`);
      }
    }

    const format = entry["format"];
    if (typeof format !== "string" || !(PUSH_FORMATS as readonly string[]).includes(format)) {
      fail(source, `${at}.format must be one of: ${PUSH_FORMATS.join(", ")}`);
    }

    const eventsValue = entry["events"] ?? [...DEFAULT_PUSH_RULES];
    if (!Array.isArray(eventsValue) || eventsValue.length === 0) {
      fail(source, `${at}.events must be a non-empty list of: ${PUSH_RULES.join(", ")}`);
    }
    const events: PushRule[] = [];
    for (const rule of eventsValue) {
      if (typeof rule !== "string" || !(PUSH_RULES as readonly string[]).includes(rule)) {
        fail(source, `${at}.events: unknown event ${JSON.stringify(rule)}`);
      }
      if (!events.includes(rule as PushRule)) events.push(rule as PushRule);
    }

    const perHour = entry["maxPerHour"] ?? DEFAULT_PUSH_PER_HOUR;
    if (
      typeof perHour !== "number" ||
      !Number.isInteger(perHour) ||
      perHour < 1 ||
      perHour > 1000
    ) {
      fail(source, `${at}.maxPerHour must be an integer from 1 to 1000`);
    }

    const channel: PushChannel = {
      name,
      format: format as PushFormat,
      events,
      maxPerHour: perHour,
    };
    for (const key of Object.keys(entry)) {
      if (key === "format" || key === "events" || key === "maxPerHour") continue;
      if (!FORMAT_KEYS[format as PushFormat].includes(key)) {
        fail(
          source,
          `${at}.${key} does not apply to format ${format}; it takes: ${FORMAT_KEYS[format as PushFormat].join(", ")}`,
        );
      }
    }
    if (format === "telegram") {
      channel.token = nonEmpty(entry["token"], `${at}.token`, source);
      channel.chatId = nonEmpty(entry["chatId"], `${at}.chatId`, source);
      if (entry["apiUrl"] !== undefined) {
        channel.apiUrl = httpUrl(entry["apiUrl"], `${at}.apiUrl`, source);
      }
    } else if (format === "feishu-app") {
      channel.appId = nonEmpty(entry["appId"], `${at}.appId`, source);
      channel.appSecret = nonEmpty(entry["appSecret"], `${at}.appSecret`, source);
      channel.receiveId = nonEmpty(entry["receiveId"], `${at}.receiveId`, source);
      const type = entry["receiveIdType"];
      if (type === undefined) {
        // An address is an email; anything else is taken as Feishu's default id.
        channel.receiveIdType = channel.receiveId.includes("@") ? "email" : "open_id";
      } else if (
        typeof type !== "string" ||
        !(FEISHU_RECEIVE_ID_TYPES as readonly string[]).includes(type)
      ) {
        fail(source, `${at}.receiveIdType must be one of: ${FEISHU_RECEIVE_ID_TYPES.join(", ")}`);
      } else {
        channel.receiveIdType = type as FeishuReceiveIdType;
      }
      if (entry["apiUrl"] !== undefined) {
        channel.apiUrl = httpUrl(entry["apiUrl"], `${at}.apiUrl`, source);
      }
    } else {
      channel.url = httpUrl(entry["url"], `${at}.url`, source);
      if (entry["secret"] !== undefined) {
        channel.secret = nonEmpty(entry["secret"], `${at}.secret`, source);
      }
    }
    channels.push(channel);
  }
  return { channels };
}

/**
 * Where a channel sends, without the part that grants access.
 *
 * Used by every surface that prints a channel. A webhook's key sits in its
 * path or query, so only the host is shown.
 */
export function describePushTarget(channel: PushChannel): string {
  if (channel.format === "telegram") return `telegram chat ${channel.chatId ?? "?"}`;
  if (channel.format === "feishu-app") {
    let host = "open.feishu.cn";
    try {
      if (channel.apiUrl !== undefined) host = new URL(channel.apiUrl).host;
    } catch {
      // Keep the default host.
    }
    return `feishu-app → ${host}, ${channel.receiveIdType ?? "open_id"} ${channel.receiveId ?? "?"}`;
  }
  try {
    return `${channel.format} → ${new URL(channel.url ?? "").host}`;
  } catch {
    return channel.format;
  }
}

/** The policy with every credential replaced, safe to print as JSON. */
export function redactNotificationPolicy(policy: NotificationPolicy): NotificationPolicy {
  return {
    channels: policy.channels.map((channel) => ({
      ...channel,
      ...(channel.url === undefined ? {} : { url: describePushTarget(channel) }),
      ...(channel.secret === undefined ? {} : { secret: "(redacted)" }),
      ...(channel.token === undefined ? {} : { token: "(redacted)" }),
      ...(channel.appSecret === undefined ? {} : { appSecret: "(redacted)" }),
    })),
  };
}
