/**
 * Messages the worker writes for the person in the chat (ADR 0030 §6, §7).
 *
 * A task requested from a chat carries `origin`. For those tasks only, the
 * worker says three things in the task's thread, each with a `relay` purpose
 * that tells intake to send it back: one acknowledgement when it takes the
 * task, the result when the run succeeds, and a short note when a person must
 * act. Everything else, progress included, stays inside oguri.
 *
 * Relay bodies are short plain text, secret-scanned, and never repeat the task
 * body: intake sends them to a chat.
 */

import { describeError, hasSecrets } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message, RelayPurpose } from "@oguri/protocol";

/** About what a phone shows without scrolling. */
export const RELAY_WORDS = 100;

/** Cut a text to at most `limit` words, on one line per paragraph. */
export function clipWords(text: string, limit: number = RELAY_WORDS): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length <= limit) return words.join(" ");
  return `${words.slice(0, limit).join(" ")} …`;
}

/** The last `limit` words of a text: where an agent's output ends with its answer. */
export function tailWords(text: string, limit: number = RELAY_WORDS): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length <= limit) return words.join(" ");
  return `… ${words.slice(-limit).join(" ")}`;
}

/** Where in a task thread a relay message goes. */
export interface RelayTarget {
  room: string;
  thread: string;
}

export function ackText(title: string): string {
  return clipWords(`On it: ${title}`);
}

/**
 * The result for the person: the run's summary and the pull request, if any.
 *
 * A summary the scanner flags is replaced, not trimmed: a chat is the last
 * place a credential should land.
 */
export function resultText(summary: string, pr?: string): string {
  const link = pr === undefined ? "" : `\n${pr}`;
  if (summary.trim().length === 0) return `Done.${link}`;
  if (hasSecrets(summary)) {
    return `Done. The summary was withheld because the secret scanner flagged it; it is in the run log on the worker's machine.${link}`;
  }
  return `${clipWords(summary, RELAY_WORDS - (pr === undefined ? 0 : 1))}${link}`;
}

export function attentionText(text: string): string {
  if (hasSecrets(text))
    return "This needs a person, but the question was withheld: the secret scanner flagged it.";
  return clipWords(text);
}

/**
 * True when the task's own request was already acknowledged in its thread.
 *
 * The same rule `oguri_task action=ack` applies: an ack that replies to a
 * message relayed from the chat acknowledges that message, and any other ack
 * acknowledges the task. Whoever wrote it, the worker or the run, the request
 * has had its one acknowledgement.
 */
export function hasAck(messages: readonly Message[], thread: string): boolean {
  const byId = new Map(messages.map((message) => [message.header.id, message]));
  return messages.some((message) => {
    if (message.header.thread !== thread || message.header.relay !== "ack") return false;
    const parent =
      message.header.inReplyTo === undefined ? undefined : byId.get(message.header.inReplyTo);
    return parent?.header.external === undefined;
  });
}

/**
 * Post one message in a task thread, as a reply to `inReplyTo`.
 *
 * Intake sends a relay message under the chat message its parent relays, or
 * under the request when the parent is the task itself. `purpose` undefined
 * writes a plain thread message, for oguri readers only.
 */
export async function postInThread(
  backend: Backend,
  target: RelayTarget & { inReplyTo: string },
  body: string,
  purpose?: RelayPurpose,
): Promise<void> {
  await backend.call("send", {
    room: target.room,
    input: {
      body,
      kind: purpose === "result" ? "answer" : "msg",
      needs: "none",
      thread: target.thread,
      inReplyTo: target.inReplyTo,
      ...(purpose === undefined ? {} : { relay: purpose }),
    },
  });
}

/** What a finished run says in the chat, decided from its report alone. */
export interface RunRelayInput {
  /** What the run published to the task, or would have for a follow-up on a completed task. */
  action: "completed" | "blocked" | "released" | "progressed";
  /** The `needsHuman` question of `result.json`, when it asked one. */
  question?: string;
  /** The answer for the person: `result.json` summary, else the session's final text. */
  summary?: string;
  pr?: string;
  /** Why the run failed, for a failed run. */
  failure?: string;
}

/**
 * The relay message for a finished run, or null when the chat hears nothing.
 *
 * A result when it is done, a question when a person must decide, a one-line
 * reason when the attempts are over. A release for another try, or a task
 * waiting for its subtasks, is still work in progress: the chat stays quiet.
 */
export function relayAfterRun(
  input: RunRelayInput,
): { purpose: "result" | "attention"; body: string } | null {
  if (input.question !== undefined) {
    return { purpose: "attention", body: attentionText(input.question) };
  }
  if (input.action === "completed") {
    return { purpose: "result", body: resultText(input.summary ?? "", input.pr) };
  }
  if (input.action === "blocked") {
    const reason = (input.failure ?? "the run did not finish").split("\n")[0] as string;
    return { purpose: "attention", body: attentionText(`I could not finish this: ${reason}.`) };
  }
  return null;
}

/**
 * Acknowledge a new task once.
 *
 * "Once" is read from the thread, not from a local file, so a task released
 * and claimed again, on this machine or another, is never acknowledged twice
 * by this agent.
 */
export async function acknowledge(
  backend: Backend,
  agentId: string,
  target: RelayTarget,
  title: string,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const messages = await backend.call<Message[]>("read", {
      room: target.room,
      thread: target.thread,
    });
    if (hasAck(Array.isArray(messages) ? messages : [], target.thread)) return false;
    // Under the request itself: the thread root is the task's first event.
    await postInThread(backend, { ...target, inReplyTo: target.thread }, ackText(title), "ack");
    return true;
  } catch (error) {
    log(`${agentId} could not acknowledge ${target.thread}: ${describeError(error)}`);
    return false;
  }
}
