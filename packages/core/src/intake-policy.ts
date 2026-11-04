/**
 * The `intake` section of the machine-local policy (ADR 0030).
 *
 * Intake watches a team chat and turns a listed person's request into a task.
 * Who may start work, in which chat, and which room and machines the work goes
 * to are decided here, by this file, before anything reaches the transport
 * repository. Messages, quotes, and documents are inputs to that decision;
 * they never change it.
 *
 * The app secret is a credential, so the section lives in `policy.yaml`, the
 * file oguri never writes or publishes.
 */

import { createHash } from "node:crypto";

import { isRoomId, isTaskCapability, isTaskTarget } from "@oguri/protocol";

/** One chat intake listens to, and where its requests go. */
export interface IntakeChat {
  /** The source's chat id, such as a Feishu `oc_...` id. */
  id: string;
  /** The oguri room its tasks are created in. */
  room: string;
  /** Who its tasks are for: an agent id or `machine:<id>`. Absent means any eligible worker. */
  target?: string;
  /** Capabilities a claimant must declare. */
  requires?: string[];
  /** Anyone in this chat may request work by addressing the bot, not only `allowed`. */
  anyone: boolean;
}

export interface FeishuIntakePolicy {
  appId: string;
  appSecret: string;
  /** API base; https://open.feishu.cn by default, https://open.larksuite.com for Lark. */
  apiUrl?: string;
  /** Seconds between polls of the chats and the followed threads. */
  pollSeconds: number;
  /** open_ids of the people who may start work by addressing the bot. */
  allowed: string[];
  /** A direct message from an allowed person is a request. */
  direct: boolean;
  /** Room for direct-message requests; required when `direct` is on. */
  directRoom?: string;
  /** Target for direct-message requests. */
  directTarget?: string;
  chats: IntakeChat[];
}

export interface IntakePolicy {
  enabled: boolean;
  feishu?: FeishuIntakePolicy;
  /** A GitHub CLI wrapper used to follow the pull requests tasks report, such as `gh`. */
  githubCli?: string;
  /** Hard ceiling on the words in one chat reply. */
  maxReplyWords: number;
}

export const DEFAULT_INTAKE_POLICY: IntakePolicy = { enabled: false, maxReplyWords: 100 };

const SECTION_KEYS = ["enabled", "feishu", "githubCli", "maxReplyWords"] as const;
const FEISHU_KEYS = [
  "appId",
  "appSecret",
  "apiUrl",
  "pollSeconds",
  "allowed",
  "direct",
  "directRoom",
  "directTarget",
  "chats",
] as const;
const CHAT_KEYS = ["room", "target", "requires", "anyone"] as const;
/** A Feishu id: `oc_`, `ou_`, `on_`, and similar prefixes, letters, digits, `_` and `-`. */
const FEISHU_ID = /^[A-Za-z0-9_-]{3,128}$/;

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function mapping(value: unknown, at: string, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, `${at} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  entry: Record<string, unknown>,
  keys: readonly string[],
  at: string,
  source: string,
): void {
  for (const key of Object.keys(entry)) {
    if (!keys.includes(key)) {
      fail(source, `unknown key '${at}.${key}'; known keys: ${keys.join(", ")}`);
    }
  }
}

function text(value: unknown, at: string, source: string): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(source, `${at} must be a non-empty string`);
  }
  return value.trim();
}

function bool(value: unknown, fallback: boolean, at: string, source: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(source, `${at} must be true or false`);
  return value;
}

function room(value: unknown, at: string, source: string): string {
  const id = text(value, at, source);
  if (!isRoomId(id)) fail(source, `${at} is not a valid room id`);
  return id;
}

function target(value: unknown, at: string, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isTaskTarget(value)) fail(source, `${at} must be an agent id or machine:<id>`);
  return value;
}

function capabilities(value: unknown, at: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isTaskCapability)) {
    fail(source, `${at} must be a list of capability names`);
  }
  return [...new Set(value as string[])];
}

function parseFeishu(value: unknown, source: string): FeishuIntakePolicy {
  const at = "intake.feishu";
  const entry = mapping(value, at, source);
  onlyKeys(entry, FEISHU_KEYS, at, source);
  const pollSeconds = entry["pollSeconds"] ?? 10;
  if (
    typeof pollSeconds !== "number" ||
    !Number.isInteger(pollSeconds) ||
    pollSeconds < 2 ||
    pollSeconds > 3600
  ) {
    fail(source, `${at}.pollSeconds must be an integer from 2 to 3600`);
  }
  const allowedValue = entry["allowed"] ?? [];
  if (!Array.isArray(allowedValue)) fail(source, `${at}.allowed must be a list of open_ids`);
  const allowed: string[] = [];
  for (const id of allowedValue) {
    if (typeof id !== "string" || !FEISHU_ID.test(id)) {
      fail(source, `${at}.allowed: ${JSON.stringify(id)} is not a Feishu open_id`);
    }
    if (!allowed.includes(id)) allowed.push(id);
  }
  const chatsValue = mapping(entry["chats"] ?? {}, `${at}.chats`, source);
  const chats: IntakeChat[] = [];
  for (const [id, raw] of Object.entries(chatsValue)) {
    const chatAt = `${at}.chats.${id}`;
    if (!FEISHU_ID.test(id)) fail(source, `${chatAt}: not a Feishu chat id`);
    const chat = mapping(raw, chatAt, source);
    onlyKeys(chat, CHAT_KEYS, chatAt, source);
    const chatTarget = target(chat["target"], `${chatAt}.target`, source);
    const requires = capabilities(chat["requires"], `${chatAt}.requires`, source);
    chats.push({
      id,
      room: room(chat["room"], `${chatAt}.room`, source),
      anyone: bool(chat["anyone"], false, `${chatAt}.anyone`, source),
      ...(chatTarget === undefined ? {} : { target: chatTarget }),
      ...(requires === undefined || requires.length === 0 ? {} : { requires }),
    });
  }
  const direct = bool(entry["direct"], false, `${at}.direct`, source);
  const directRoom =
    entry["directRoom"] === undefined
      ? undefined
      : room(entry["directRoom"], `${at}.directRoom`, source);
  if (direct && directRoom === undefined) {
    fail(source, `${at}.directRoom is required when ${at}.direct is true`);
  }
  const directTarget = target(entry["directTarget"], `${at}.directTarget`, source);
  let apiUrl: string | undefined;
  if (entry["apiUrl"] !== undefined) {
    const url = text(entry["apiUrl"], `${at}.apiUrl`, source);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail(source, `${at}.apiUrl is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      fail(source, `${at}.apiUrl must be an http or https URL`);
    }
    apiUrl = url;
  }
  if (chats.length === 0 && !direct) {
    fail(source, `${at} listens to nothing: add a chat under ${at}.chats or set direct: true`);
  }
  return {
    appId: text(entry["appId"], `${at}.appId`, source),
    appSecret: text(entry["appSecret"], `${at}.appSecret`, source),
    pollSeconds,
    allowed,
    direct,
    chats,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(directRoom === undefined ? {} : { directRoom }),
    ...(directTarget === undefined ? {} : { directTarget }),
  };
}

/** Parse `intake:`, refusing anything it does not understand. */
export function parseIntakePolicy(value: unknown, source: string): IntakePolicy {
  const section = mapping(value, "intake", source);
  onlyKeys(section, SECTION_KEYS, "intake", source);
  const maxReplyWords = section["maxReplyWords"] ?? DEFAULT_INTAKE_POLICY.maxReplyWords;
  if (
    typeof maxReplyWords !== "number" ||
    !Number.isInteger(maxReplyWords) ||
    maxReplyWords < 10 ||
    maxReplyWords > 500
  ) {
    fail(source, "intake.maxReplyWords must be an integer from 10 to 500");
  }
  const enabled = bool(section["enabled"], false, "intake.enabled", source);
  const feishu =
    section["feishu"] === undefined ? undefined : parseFeishu(section["feishu"], source);
  if (enabled && feishu === undefined) {
    fail(source, "intake.enabled is true but no source is configured; add intake.feishu");
  }
  const githubCli =
    section["githubCli"] === undefined
      ? undefined
      : text(section["githubCli"], "intake.githubCli", source);
  return {
    enabled,
    maxReplyWords,
    ...(feishu === undefined ? {} : { feishu }),
    ...(githubCli === undefined ? {} : { githubCli }),
  };
}

/**
 * The policy version a mandate records: a hash of who may start work and where
 * it goes, without credentials or timing. Changing the allowed list, a chat's
 * room or target, or `anyone` changes it; rotating the secret does not.
 */
export function intakePolicyVersion(policy: IntakePolicy): string {
  const feishu = policy.feishu;
  const material = {
    enabled: policy.enabled,
    feishu:
      feishu === undefined
        ? null
        : {
            allowed: [...feishu.allowed].sort(),
            direct: feishu.direct,
            directRoom: feishu.directRoom ?? null,
            directTarget: feishu.directTarget ?? null,
            chats: [...feishu.chats]
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map((chat) => ({
                id: chat.id,
                room: chat.room,
                target: chat.target ?? null,
                requires: [...(chat.requires ?? [])].sort(),
                anyone: chat.anyone,
              })),
          },
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}

/** The policy with the app secret replaced, safe to print as JSON. */
export function redactIntakePolicy(policy: IntakePolicy): IntakePolicy {
  if (policy.feishu === undefined) return policy;
  return { ...policy, feishu: { ...policy.feishu, appSecret: "(redacted)" } };
}
