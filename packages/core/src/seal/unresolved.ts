import { isTerminalReviewTaskState, isTerminalTaskState, type Message } from "@oguri/protocol";

import { reduceReviewTasks } from "../review/tasks.ts";
import { reduceTasks } from "../task/tasks.ts";

function chronological(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const byTime = Date.parse(a.header.ts) - Date.parse(b.header.ts);
    if (byTime !== 0) return byTime;
    return a.header.id < b.header.id ? -1 : a.header.id > b.header.id ? 1 : 0;
  });
}

/**
 * Items whose raw chain must remain in the live window.
 *
 * Generic messages use question/answer semantics. Review and collaborative
 * tasks use their explicit lifecycles instead: the current event is unresolved
 * until a terminal state, even when an administrative event carries
 * `needs: none`.
 */
export function unresolvedMessages(messages: readonly Message[]): Message[] {
  const reviewStatuses = reduceReviewTasks(messages);
  const taskStatuses = reduceTasks(messages);
  const recognizedReviewIds = new Set(reviewStatuses.map((status) => status.review.id));
  const recognizedTaskIds = new Set(taskStatuses.map((status) => status.task.id));
  const answered = new Set(
    messages
      .filter(
        (message) => message.header.kind === "answer" && message.header.inReplyTo !== undefined,
      )
      .map((message) => message.header.inReplyTo as string),
  );
  const generic = messages.filter(
    (message) =>
      (message.header.review === undefined || !recognizedReviewIds.has(message.header.review.id)) &&
      (message.header.task === undefined || !recognizedTaskIds.has(message.header.task.id)) &&
      message.header.needs !== "none" &&
      !answered.has(message.header.id),
  );

  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const activeReviews = reviewStatuses.flatMap((status) => {
    if (isTerminalReviewTaskState(status.review.state)) return [];
    const current = byId.get(status.currentMessageId);
    return current === undefined ? [] : [current];
  });

  const activeTasks = taskStatuses.flatMap((status) => {
    if (isTerminalTaskState(status.task.state)) return [];
    const current = byId.get(status.currentMessageId);
    return current === undefined ? [] : [current];
  });

  return chronological([...generic, ...activeReviews, ...activeTasks]);
}

/**
 * Finished tasks that another task in the live window still depends on.
 *
 * A claim is valid only if its dependencies completed before it in the room's
 * order. Pruning a completed dependency while its dependent is still in the
 * window would make every reader re-reduce the dependent's claim as premature,
 * and work already done would fall back to open. So a dependency stays raw for
 * as long as anything that depends on it is reduced from the window, and is
 * released with it.
 *
 * Kept apart from `unresolvedMessages` because nothing about these is open:
 * the digest must not list them as carried-forward questions. Returns each
 * dependency's current event; the sealer keeps its reply chain.
 */
export function retainedTaskDependencies(messages: readonly Message[]): Message[] {
  const statuses = reduceTasks(messages);
  const byTask = new Map(statuses.map((status) => [status.task.id, status]));
  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const retained = new Set<Message>();
  for (const status of statuses) {
    for (const id of status.task.dependsOn ?? []) {
      const dependency = byTask.get(id);
      if (dependency === undefined || !isTerminalTaskState(dependency.task.state)) continue;
      const current = byId.get(dependency.currentMessageId);
      if (current !== undefined) retained.add(current);
    }
  }
  return chronological([...retained]);
}
