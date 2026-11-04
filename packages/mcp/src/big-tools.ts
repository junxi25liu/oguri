/**
 * `oguri_big`: the conversation with the big superagent (ADR 0031).
 *
 * A request is an ordinary message tagged `to-big` in the machine-local
 * `superagent.big.room`; the big role replies in the same thread with
 * `from-superagent`. Nothing here starts a run: the superagent is enabled, and
 * started, only on the machine whose person set `superagent.big.enabled`.
 *
 * The tags are duplicated from `@oguri/superagent` deliberately. Depending on
 * it would pull the model runner, the worker and the intake packages into every
 * MCP session for two string literals — and it would make the wire contract
 * something a package could change without meaning to.
 */

import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

/** Tags from ADR 0031. Keep them in step with superagent/src/act.ts. */
export const TO_BIG_TAG = "to-big";
export const FROM_SUPERAGENT_TAG = "from-superagent";

/** Where the conversation is, from the machine-local policy (redacted on the wire). */
export interface BigRoom {
  room: string;
  enabled: boolean;
}

export async function bigRoom(backend: Backend): Promise<BigRoom> {
  const resolved = await backend.call<{
    policy: { superagent: { big: { enabled?: boolean; room?: string } } };
  }>("policy");
  const big = resolved.policy.superagent.big;
  return { room: big.room ?? "superagent", enabled: big.enabled === true };
}

/** The room may exist on the network but not locally; a send needs a subscription. */
export async function ensureBigRoom(backend: Backend, room: string): Promise<void> {
  const status = await backend.call<{ subscriptions: string[] }>("status");
  if (status.subscriptions.includes(room)) return;
  try {
    await backend.call("roomJoin", { room });
  } catch {
    try {
      // Conversations with the superagent are long; the generic budget would park them.
      await backend.call("roomCreate", {
        room,
        title: "Superagent",
        purpose: "Talk to the big superagent here.",
        replyBudget: 500,
      });
    } catch (error) {
      if (!/already exists/.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      await backend.call("roomJoin", { room });
    }
  }
}

/** `action=send`: hand one message to Big and return the thread to read replies from. */
export async function bigSend(
  backend: Backend,
  { room, enabled }: BigRoom,
  body: string,
): Promise<{
  sent: string;
  thread: string;
  room: string;
  bigEnabledHere: boolean;
  replyWith: string;
}> {
  await ensureBigRoom(backend, room);
  const sent = await backend.call<Message>("send", {
    room,
    input: { body, kind: "msg", needs: "none", tags: [TO_BIG_TAG] },
  });
  return {
    sent: sent.header.id,
    thread: sent.header.thread,
    room: sent.header.room,
    bigEnabledHere: enabled,
    replyWith: `oguri_big action=replies thread=${sent.header.thread}`,
  };
}

/** What one message in the conversation looks like when read back. */
export interface BigConversationMessage {
  id: string;
  from: string;
  ts: string;
  body: string;
  role: "you" | "big";
  inReplyTo?: string;
}

/** `action=replies`: the messages of one conversation, oldest first. */
export async function bigReplies(
  backend: Backend,
  { room, enabled }: BigRoom,
  thread: string,
  limit = 50,
): Promise<{
  room: string;
  thread: string;
  bigEnabledHere: boolean;
  messages: BigConversationMessage[];
  replies: BigConversationMessage[];
}> {
  const read = await backend.call<Message[]>("read", { room, thread, limit: 500 });
  const isBig = (message: Message): boolean => message.header.tags.includes(FROM_SUPERAGENT_TAG);
  const shown = (message: Message): BigConversationMessage => ({
    id: message.header.id,
    from: message.header.from,
    ts: message.header.ts,
    body: message.body,
    role: isBig(message) ? "big" : "you",
    ...(message.header.inReplyTo === undefined ? {} : { inReplyTo: message.header.inReplyTo }),
  });
  const messages = read.slice(-limit).map(shown);
  return {
    room,
    thread,
    bigEnabledHere: enabled,
    messages,
    replies: messages.filter((message) => message.role === "big"),
  };
}
