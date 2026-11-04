/**
 * Replies a run sends back to the chat its task came from (ADR 0030 §6, §7).
 *
 * A task with an `origin` was asked for by a person in a chat. Intake sends
 * every message in the task thread that carries a `relay` purpose back to that
 * conversation, so these actions are the run's only voice there. Each one
 * checks the task thread before it writes: the chat should hear one
 * acknowledgement per request, answers to what a person actually asked, and a
 * clear handback when a request is beyond the task.
 *
 * Like the other in-run actions, `room` and `taskId` default to the run's own
 * (`OGURI_TASK_ROOM`, `OGURI_TASK_ID`).
 */

import type { TaskDetail } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { compareUlid, type Message, type MessageKind, type RelayPurpose } from "@oguri/protocol";

import { currentTaskOf } from "./task-run-tools.ts";

type TextResult = { content: { type: "text"; text: string }[] };

function text(value: unknown): TextResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** An acknowledgement says what was understood and what happens next, nothing more. */
export const MAX_ACK_WORDS = 100;

/** Appended to a handback, so the person knows what to do with the request. */
export const HANDBACK_NOTE = "This is beyond the current task. Please send it as a new request.";

/**
 * Scripts written without spaces between words: each character counts as one
 * word, so a Chinese or Japanese acknowledgement is held to a similar length.
 */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/** Words in a reply, counting each Han or kana character as a word and punctuation as none. */
export function countWords(body: string): number {
  const unspaced = body.match(UNSPACED)?.length ?? 0;
  const rest = body
    .replace(UNSPACED, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  return unspaced + rest.length;
}

interface Target {
  room?: string | undefined;
  taskId?: string | undefined;
}

interface RelayContext {
  room: string;
  taskId: string;
  detail: TaskDetail;
  /** The task thread, oldest first. */
  thread: Message[];
}

async function relayContext(
  backend: Backend,
  input: Target,
  env: NodeJS.ProcessEnv,
): Promise<RelayContext> {
  const { room, taskId } = currentTaskOf(input.room, input.taskId, env);
  const detail = await backend.call<TaskDetail>("taskShow", { room, taskId });
  if (detail.task.origin === undefined) {
    throw new Error(
      `task ${taskId} has no origin: it was not requested from a chat, so there is nowhere to relay this. ` +
        "Use action=progress or action=ask.",
    );
  }
  const messages = await backend.call<Message[]>("read", { room, thread: detail.thread });
  const thread = [...messages].sort((a, b) => compareUlid(a.header.id, b.header.id));
  return { room, taskId, detail, thread };
}

/** The newest message in the thread that relays a person's words. */
function newestHumanExternal(thread: readonly Message[]): Message | undefined {
  return thread.findLast((message) => message.header.external?.human === true);
}

function inThread(context: RelayContext, id: string): Message {
  const message = context.thread.find((m) => m.header.id === id);
  if (message === undefined) {
    throw new Error(`message ${id} is not in the thread of task ${context.taskId}`);
  }
  return message;
}

function externalInThread(context: RelayContext, id: string): Message {
  const message = inThread(context, id);
  if (message.header.external === undefined) {
    throw new Error(
      `message ${id} does not relay a person's message (it has no external source); ` +
        "inReplyTo must name a message from the chat",
    );
  }
  return message;
}

async function sendRelay(
  backend: Backend,
  context: RelayContext,
  relay: RelayPurpose,
  kind: MessageKind,
  body: string,
  inReplyTo: string,
): Promise<TextResult> {
  const sent = await backend.call<Message>("send", {
    room: context.room,
    input: { body, kind, needs: "none", relay, inReplyTo },
  });
  return text({
    sent: sent.header.id,
    relay,
    inReplyTo,
    thread: sent.header.thread,
    task: context.taskId,
  });
}

/**
 * `ack`: confirm a request once.
 *
 * Without `inReplyTo` it acknowledges the task's own request, under the task
 * root. With it, it acknowledges a later message from the chat, such as a
 * follow-up that asks for more. Either way one request gets one ack.
 */
export async function taskAck(
  backend: Backend,
  input: Target & { body: string; inReplyTo?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextResult> {
  const words = countWords(input.body);
  if (words > MAX_ACK_WORDS) {
    throw new Error(
      `an acknowledgement is at most ${String(MAX_ACK_WORDS)} words; this one has ${String(words)}. ` +
        "Say what you understood and what you will do, nothing more.",
    );
  }
  const context = await relayContext(backend, input, env);
  const root = context.detail.rootMessageId;
  const subject =
    input.inReplyTo === undefined ? root : externalInThread(context, input.inReplyTo).header.id;
  // What an earlier ack acknowledged: the chat message it replies to, or else
  // the task's own request, wherever in the thread it was posted.
  const acknowledged = (ack: Message): string => {
    const parent = context.thread.find((m) => m.header.id === ack.header.inReplyTo);
    return parent?.header.external === undefined ? root : parent.header.id;
  };
  const earlier = context.thread.find(
    (message) => message.header.relay === "ack" && acknowledged(message) === subject,
  );
  if (earlier !== undefined) {
    throw new Error(
      `${subject === root ? "this task's request" : `message ${subject}`} was already acknowledged ` +
        `in ${earlier.header.id}; one acknowledgement per request. Work quietly and report the result.`,
    );
  }
  return await sendRelay(backend, context, "ack", "msg", input.body, subject);
}

/** `answer`: reply to a person's message in the task thread, by default the newest one. */
export async function taskAnswer(
  backend: Backend,
  input: Target & { body: string; inReplyTo?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextResult> {
  const context = await relayContext(backend, input, env);
  let question: Message;
  if (input.inReplyTo !== undefined) {
    question = externalInThread(context, input.inReplyTo);
  } else {
    const newest = newestHumanExternal(context.thread);
    if (newest === undefined) {
      throw new Error(
        `nobody in the chat has written in the thread of task ${context.taskId}, so there is nothing to answer. ` +
          "Put the final result in result.json.",
      );
    }
    question = newest;
  }
  return await sendRelay(backend, context, "answer", "answer", input.body, question.header.id);
}

/**
 * `handback`: tell the person a request is beyond this task.
 *
 * Replies to `inReplyTo`, or to the newest message from the chat, or to the
 * task's request when nobody has written since.
 */
/** Tag on a handback from a task with no chat, for the superagent that deployed it (ADR 0032). */
export const HANDBACK_TAG = "task-handback";

export async function taskHandback(
  backend: Backend,
  input: Target & { body: string; inReplyTo?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TextResult> {
  const { room, taskId } = currentTaskOf(input.room, input.taskId, env);
  const detail = await backend.call<TaskDetail>("taskShow", { room, taskId });
  if (detail.task.origin === undefined) {
    // No chat to answer in: the big superagent reads the thread and decides it afresh.
    const sent = await backend.call<Message>("send", {
      room,
      input: {
        body: input.body.trimEnd(),
        kind: "msg",
        needs: "none",
        thread: detail.thread,
        inReplyTo: input.inReplyTo ?? detail.currentMessageId,
        tags: [HANDBACK_TAG],
      },
    });
    return text({ sent: sent.header.id, handback: true, thread: sent.header.thread, task: taskId });
  }
  const context = await relayContext(backend, input, env);
  const parent =
    input.inReplyTo === undefined
      ? (newestHumanExternal(context.thread)?.header.id ?? context.detail.rootMessageId)
      : inThread(context, input.inReplyTo).header.id;
  const body = `${input.body.trimEnd()}\n\n${HANDBACK_NOTE}`;
  return await sendRelay(backend, context, "handback", "msg", body, parent);
}
