/**
 * What intake writes for an admitted chat message (ADR 0030 §3, §4).
 *
 * Pure: the message and the admission decide every field. `intake.ts` does
 * the writing and the bookkeeping around it.
 */

import {
  EXTERNAL_CONTEXT_TAG,
  MENTION_ROOM,
  type TaskMandate,
  type TaskOrigin,
} from "@oguri/protocol";
import type { SendInput, TaskCreateInput, TaskStatus } from "@oguri/core";

import type { InboundMessage } from "./source.ts";

/** The protocol's limit on a task title: one line of at most 200 characters. */
export const TITLE_LIMIT = 200;

/** Tag on a relayed message whose sender may not start work: context, never a resume. */
export const CONTEXT_TAG = EXTERNAL_CONTEXT_TAG;

const SOURCE_NAMES: Readonly<Record<string, string>> = { feishu: "Feishu" };

/** The first line with words in it, cut to the title limit. */
export function taskTitle(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const clean = line.replace(/\s+/g, " ");
  if (clean.length <= TITLE_LIMIT) return clean;
  return `${clean.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

export function taskOrigin(message: InboundMessage): TaskOrigin {
  const { external } = message;
  return {
    source: external.source,
    conversation: external.conversation ?? "",
    message: external.id,
    requester: external.actor,
    ...(external.thread === undefined ? {} : { thread: external.thread }),
    ...(message.url === undefined ? {} : { url: message.url }),
  };
}

export function taskRequest(
  message: InboundMessage,
  decision: { target?: string; requires?: string[]; mandate: TaskMandate },
): TaskCreateInput {
  const { external } = message;
  const who = external.actorName ?? external.actor;
  const where = SOURCE_NAMES[external.source] ?? external.source;
  const link = message.url === undefined ? "" : `: ${message.url}`;
  return {
    title: taskTitle(message.text),
    definition: `${message.text.trim()}\n\nRequested by ${who} in ${where}${link}`,
    origin: taskOrigin(message),
    mandate: decision.mandate,
    ...(decision.target === undefined ? {} : { target: decision.target }),
    ...(decision.requires === undefined ? {} : { requires: decision.requires }),
  };
}

/**
 * A follow-up as a message in the task's thread.
 *
 * It mentions whoever holds the task, or whoever it is for, so it reaches an
 * inbox. A follow-up from someone who may not start work carries
 * `CONTEXT_TAG` and asks nothing of anyone: it is there to be read, not acted on.
 */
export function followupMessage(
  message: InboundMessage,
  threadRoot: string,
  status: TaskStatus | undefined,
  admitted: boolean,
): SendInput {
  const recipient = status?.task.assignee ?? status?.task.target ?? MENTION_ROOM;
  return {
    body: message.text.trim().length === 0 ? "(empty message)" : message.text,
    kind: "msg",
    authorKind: "human",
    needs: admitted ? "agent" : "none",
    mentions: [recipient],
    thread: threadRoot,
    external: message.external,
    ...(admitted ? {} : { tags: [CONTEXT_TAG] }),
  };
}
