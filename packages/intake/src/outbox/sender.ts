/**
 * What the outbox needs from a chat: send one reply, or say it can never land.
 */

import type { OutboundReply } from "./types.ts";

/** What a source said after accepting a reply. */
export interface SentReply {
  /** The source's id for the reply, when it returned one. */
  id?: string;
}

export interface ReplySender {
  /**
   * Send one reply.
   * @throws ReplyGoneError when the conversation or the message it answers no
   *   longer exists, so no retry can ever succeed. Any other error is retried.
   */
  send(reply: OutboundReply): Promise<SentReply>;
}

/** The reply's target is gone: the bot left the chat, or the message was recalled or deleted. */
export class ReplyGoneError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ReplyGoneError";
  }
}
