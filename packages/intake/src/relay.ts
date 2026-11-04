/**
 * What may go back to a chat, and where it goes (ADR 0030 §6, §7).
 *
 * A reply leaves oguri for a system with its own retention and audience, so
 * it is cut down before it goes: one line of plain text, no control
 * characters, at most `intake.maxReplyWords` words, and nothing the secret
 * scanner flags. A flagged reply is replaced whole rather than redacted, so no
 * part of a credential reaches the chat.
 */

import { DEFAULT_INTAKE_POLICY, hasSecrets } from "@oguri/core";
import type { Message, RelayPurpose, Task } from "@oguri/protocol";

import type { OutboundReply } from "./outbox/types.ts";

export const WITHHELD_REPLY =
  "(withheld: the secret scanner flagged this reply; see the task in oguri)";

/** What a relay says when its message had no text left after cleaning. */
const EMPTY_REPLY: Readonly<Record<RelayPurpose, string>> = {
  ack: "Received; working on it.",
  answer: "(no text; see the task in oguri)",
  attention: "This needs a person; see the task in oguri.",
  result: "Finished; see the task in oguri.",
  handback: "Handed back; see the task in oguri.",
};

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
/** A CJK character, or a run of anything else that is not space. */
const WORD = new RegExp(`[${CJK}]|[^\\s${CJK}]+`, "gu");
/** Punctuation alone is not a word: `你好，世界` is four. */
const PUNCTUATION = /^[\p{P}\p{S}]+$/u;
/**
 * C0 and C1 controls, and the invisible characters that reorder or hide text.
 * The zero-width joiner stays: emoji sequences use it.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

export interface ComposeOptions {
  maxWords: number;
}

/** Count words: each CJK character is one, and so is each other run of non-space. */
export function countWords(text: string): number {
  let count = 0;
  for (const match of text.matchAll(WORD)) {
    if (!PUNCTUATION.test(match[0])) count += 1;
  }
  return count;
}

/** Keep the first `maxWords` words, ending with `…` when anything was cut. */
export function limitWords(text: string, maxWords: number): string {
  let count = 0;
  for (const match of text.matchAll(WORD)) {
    if (PUNCTUATION.test(match[0])) continue;
    count += 1;
    if (count > maxWords) return `${text.slice(0, match.index).trimEnd()}…`;
  }
  return text;
}

/** One line of visible text. */
export function flattenText(text: string): string {
  return text.replace(/\s+/gu, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
}

/** The text a chat receives for one relay. */
export function composeReply(purpose: RelayPurpose, text: string, options: ComposeOptions): string {
  const flat = flattenText(text);
  // Scan both: the scanner reads line by line, and flattening joins lines.
  if (hasSecrets(text) || hasSecrets(flat)) return WITHHELD_REPLY;
  if (flat.length === 0) return EMPTY_REPLY[purpose];
  return limitWords(flat, Math.max(1, options.maxWords));
}

/** A task as relaying needs it: its origin, and the thread its messages are in. */
export interface RelayTask {
  task: Pick<Task, "id" | "origin">;
  /** The task thread: the id of its created event. */
  thread: string;
}

export interface RelayOptions {
  maxReplyWords: number;
  /** The message `message` replies to, when it replies to one. */
  parent?: Message;
}

/**
 * The reply one relay message produces, or null when it produces none.
 *
 * A message produces a reply when it carries `relay`, sits in the thread of a
 * task with an `origin`, and was written by an agent. A message relayed in
 * from the chat (it carries `external`) never goes back, so intake can never
 * echo a person to themselves. An `answer` to a person's follow-up goes under
 * that follow-up; everything else goes under the request.
 */
export function relaysFor(
  message: Message,
  task: RelayTask,
  options: Partial<RelayOptions> = {},
): OutboundReply | null {
  const purpose = message.header.relay;
  const origin = task.task.origin;
  if (purpose === undefined || origin === undefined) return null;
  if (message.header.thread !== task.thread) return null;
  if (message.header.external !== undefined || message.header.authorKind !== "agent") return null;

  let replyTo = origin.message;
  let conversation = origin.conversation;
  const external = options.parent?.header.external;
  if (
    purpose === "answer" &&
    external !== undefined &&
    options.parent?.header.id === message.header.inReplyTo &&
    external.source === origin.source
  ) {
    replyTo = external.id;
    conversation = external.conversation ?? origin.conversation;
  }
  return {
    key: `relay:${message.header.id}`,
    source: origin.source,
    conversation,
    replyTo,
    text: composeReply(purpose, message.body, {
      maxWords: options.maxReplyWords ?? DEFAULT_INTAKE_POLICY.maxReplyWords,
    }),
    purpose,
    taskId: task.task.id,
  };
}
