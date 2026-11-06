/**
 * The dashboard's "Needs you" list (ADR 0030): what is waiting on a person.
 *
 * Three cases, each derived from the room log alone:
 *
 * - a task blocked or stuck with `needs: human` on its current event;
 * - an unfinished task whose thread has an `attention` relay that no person in
 *   the chat has answered, meaning no human `external` message came after it;
 * - a completed task whose completion names a pull request. oguri cannot see
 *   the code host, so it cannot tell whether the PR merged. It lists them for
 *   `PR_WINDOW_DAYS` after completion, the same window a worker takes follow-ups in.
 *
 * Pure: the caller reads the rooms, this decides. The dashboard uses
 * `messageId` and `taskId` to locate the message/result and to open a chat
 * about the task; it never invents a link that the message did not publish.
 */

import type { TaskStatus } from "@oguri/core";
import { compareUlid, isTerminalTaskState, type Message } from "@oguri/protocol";

/** How long a completed task with a pull request stays listed. */
export const PR_WINDOW_DAYS = 14;

export type NeedsYouReason = "needs-human" | "attention" | "pull-request";

export interface NeedsYouItem {
  reason: NeedsYouReason;
  taskId: string;
  title: string;
  room: string;
  /** The chat the task came from, when it has an origin. */
  source: string | null;
  requester: string | null;
  /** When the thing that needs you happened. */
  since: string;
  /** The pull request for `pull-request`, otherwise the origin's link. */
  link: string | null;
  /** The message to look at. */
  messageId: string;
  /** The task thread, for locating a conversation in the room log. */
  thread?: string | null;
}

/** A ref that is a web link. The worker publishes a run's `pr` as a bare URL. */
function isLink(ref: string): boolean {
  return /^https?:\/\//.test(ref);
}

/** Everything that needs a person in one room, oldest first within each reason. */
export function needsYou(
  room: string,
  tasks: readonly TaskStatus[],
  messages: readonly Message[],
  now = Date.now(),
): NeedsYouItem[] {
  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const items: NeedsYouItem[] = [];
  for (const status of tasks) {
    const task = status.task;
    const base = {
      taskId: task.id,
      title: task.title,
      room,
      source: task.origin?.source ?? null,
      requester: task.origin?.requester ?? null,
      thread: status.thread,
    };
    const current = byId.get(status.currentMessageId);

    if ((task.state === "blocked" || task.state === "stuck") && current?.header.needs === "human") {
      items.push({
        ...base,
        reason: "needs-human",
        since: status.updatedAt,
        link: task.origin?.url ?? null,
        messageId: status.currentMessageId,
      });
    }

    const thread = messages
      .filter((message) => message.header.thread === status.thread)
      .sort((a, b) => compareUlid(a.header.id, b.header.id));
    let attention: Message | undefined;
    for (const message of thread) {
      if (message.header.relay === "attention") attention = message;
      else if (attention !== undefined && message.header.external?.human === true) {
        attention = undefined;
      }
    }
    if (attention !== undefined && !isTerminalTaskState(task.state)) {
      items.push({
        ...base,
        reason: "attention",
        since: attention.header.ts,
        link: task.origin?.url ?? null,
        messageId: attention.header.id,
      });
    }

    if (task.state === "completed" && current !== undefined) {
      const pr = current.header.refs.find(isLink);
      const age = now - Date.parse(status.updatedAt);
      if (pr !== undefined && age < PR_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        items.push({
          ...base,
          reason: "pull-request",
          since: status.updatedAt,
          link: pr,
          messageId: status.currentMessageId,
        });
      }
    }
  }
  return items;
}

const ORDER: Record<NeedsYouReason, number> = {
  "needs-human": 0,
  attention: 1,
  "pull-request": 2,
};

/** Decisions first, then unanswered questions, then pull requests; oldest first within each. */
export function sortNeedsYou(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return [...items].sort(
    (a, b) =>
      ORDER[a.reason] - ORDER[b.reason] ||
      a.since.localeCompare(b.since) ||
      a.taskId.localeCompare(b.taskId),
  );
}

/** One item, or null. The dashboard highlights it when a task is selected. */
export function needsYouForTask(
  items: readonly NeedsYouItem[],
  taskId: string,
): NeedsYouItem | null {
  return sortNeedsYou(items).find((item) => item.taskId === taskId) ?? null;
}
