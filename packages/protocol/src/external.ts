/**
 * Where a message or a task came from outside oguri, and why a reply goes back (ADR 0030).
 *
 * An intake process watches a team chat, such as a Feishu group, and turns a
 * person's request into a task and their later messages into task-thread
 * messages. Those messages are written by the intake agent, so `from` names
 * that agent; the person who actually spoke is recorded here, in the source's
 * own identity, so every reader sees who asked and where to answer.
 *
 * Every field identifies; none authenticates. The intake agent asserts them,
 * exactly as it asserts `from`. What a person may start is decided by the
 * intake machine's local policy before anything is written, and recorded on
 * the task as its mandate.
 */

import { MalformedMessageError } from "./errors.ts";

/** A chat or code-host name, such as `feishu` or `github`. */
export const EXTERNAL_SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Upper bound for an external id, conversation, actor, or name. */
export const MAX_EXTERNAL_FIELD = 256;

/**
 * Tag on a relayed message whose sender may not start work (ADR 0030 §4): the
 * message is there to be read, and it never resumes a run. A tag rather than
 * wording in the body, so what someone writes in a chat cannot change it.
 */
export const EXTERNAL_CONTEXT_TAG = "external-context";

/** Why a message in a task thread should be sent back to the task's origin conversation. */
export const RELAY_PURPOSES = ["ack", "answer", "attention", "result", "handback"] as const;
export type RelayPurpose = (typeof RELAY_PURPOSES)[number];

/** The outside event a message relays. */
export interface ExternalRef {
  /** The source, such as `feishu`. */
  source: string;
  /** The source's message id. With `source`, the dedupe key: one external message, one oguri message. */
  id: string;
  /** The conversation it was written in, such as a Feishu chat id. */
  conversation?: string;
  /** The source's thread, such as a Feishu root or thread id. */
  thread?: string;
  /** Who wrote it, in the source's own identity, such as a Feishu open_id. */
  actor: string;
  /** A display name for the actor, when the source gives one. */
  actorName?: string;
  /** The source said a person wrote it, rather than a bot or an app. */
  human: boolean;
}

export const EXTERNAL_WIRE_KEYS = [
  "external_source",
  "external_id",
  "external_conversation",
  "external_thread",
  "external_actor",
  "external_actor_name",
  "external_human",
  "relay",
] as const;

/** A short single-line field from another system: no control characters, bounded. */
export function isExternalField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EXTERNAL_FIELD &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

export function isExternalSource(value: unknown): value is string {
  return typeof value === "string" && EXTERNAL_SOURCE_PATTERN.test(value);
}

export function isRelayPurpose(value: unknown): value is RelayPurpose {
  return typeof value === "string" && (RELAY_PURPOSES as readonly string[]).includes(value);
}

function field(
  raw: Record<string, unknown>,
  key: string,
  required: boolean,
  source: string | undefined,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required) throw new MalformedMessageError(`header field ${key} is required`, source);
    return undefined;
  }
  if (!isExternalField(value)) {
    throw new MalformedMessageError(
      `header field ${key} must be a single-line string of at most ${String(MAX_EXTERNAL_FIELD)} characters`,
      source,
    );
  }
  return value;
}

/** Parse the external reference, or undefined when the message carries none. */
export function parseExternal(
  raw: Record<string, unknown>,
  source?: string,
): ExternalRef | undefined {
  const present = EXTERNAL_WIRE_KEYS.filter(
    (key) => key !== "relay" && raw[key] !== undefined && raw[key] !== null,
  );
  if (present.length === 0) return undefined;
  const from = raw["external_source"];
  if (!isExternalSource(from)) {
    throw new MalformedMessageError(
      "header field external_source must match [a-z][a-z0-9-]{0,31}",
      source,
    );
  }
  const human = raw["external_human"];
  if (typeof human !== "boolean") {
    throw new MalformedMessageError("header field external_human must be a boolean", source);
  }
  const conversation = field(raw, "external_conversation", false, source);
  const thread = field(raw, "external_thread", false, source);
  const actorName = field(raw, "external_actor_name", false, source);
  return {
    source: from,
    id: field(raw, "external_id", true, source) as string,
    actor: field(raw, "external_actor", true, source) as string,
    human,
    ...(conversation === undefined ? {} : { conversation }),
    ...(thread === undefined ? {} : { thread }),
    ...(actorName === undefined ? {} : { actorName }),
  };
}

export function parseRelay(
  raw: Record<string, unknown>,
  source?: string,
): RelayPurpose | undefined {
  const value = raw["relay"];
  if (value === undefined || value === null) return undefined;
  if (!isRelayPurpose(value)) {
    throw new MalformedMessageError(
      `header field relay must be one of: ${RELAY_PURPOSES.join(", ")}`,
      source,
    );
  }
  return value;
}

export function externalToWire(external: ExternalRef): Record<string, unknown> {
  return {
    external_source: external.source,
    external_id: external.id,
    ...(external.conversation === undefined
      ? {}
      : { external_conversation: external.conversation }),
    ...(external.thread === undefined ? {} : { external_thread: external.thread }),
    external_actor: external.actor,
    ...(external.actorName === undefined ? {} : { external_actor_name: external.actorName }),
    external_human: external.human,
  };
}

/** The dedupe key of an external message: one outside event is relayed once. */
export function externalKey(external: Pick<ExternalRef, "source" | "id">): string {
  return `${external.source}:${external.id}`;
}
