/**
 * Send outbox replies to Feishu, under the message they answer (ADR 0030 §6).
 *
 * Every reply is plain text, in the thread of the message it answers. The
 * outbox key, cut to Feishu's 50-character limit, goes as `uuid`: Feishu sends
 * at most one message per uuid within an hour, so a retry after a timeout that
 * actually landed does not post the reply twice.
 */

import { FeishuApiError, type FeishuClient } from "../feishu/client.ts";
import { ReplyGoneError, type ReplySender, type SentReply } from "./sender.ts";
import type { OutboundReply } from "./types.ts";

/** Feishu's limit on a reply's `uuid`. */
export const FEISHU_UUID_LIMIT = 50;

/**
 * Feishu codes meaning the reply can never land, from the reply API's error
 * table. Anything else that is refused is retried with backoff, because an
 * administrator can fix it: a missing permission, a muted group.
 */
export const FEISHU_GONE_CODES: ReadonlyMap<number, string> = new Map([
  // Also what an unknown or malformed message id returns.
  [230001, "the message to reply to is invalid or does not exist"],
  [230002, "the bot is not in the chat"],
  [230011, "the message to reply to was recalled"],
  [230019, "the topic does not exist"],
  [230050, "the message to reply to is not visible to the bot"],
  [230110, "the message to reply to was deleted"],
  [232009, "the chat was dissolved"],
]);

export function feishuReplyBody(reply: OutboundReply): Record<string, unknown> {
  return {
    msg_type: "text",
    content: JSON.stringify({ text: reply.text }),
    reply_in_thread: true,
    uuid: reply.key.slice(0, FEISHU_UUID_LIMIT),
  };
}

export class FeishuReplySender implements ReplySender {
  private readonly client: FeishuClient;

  constructor(client: FeishuClient) {
    this.client = client;
  }

  async send(reply: OutboundReply): Promise<SentReply> {
    let data: { message_id?: unknown };
    try {
      data = await this.client.call<{ message_id?: unknown }>({
        method: "POST",
        path: `/open-apis/im/v1/messages/${encodeURIComponent(reply.replyTo)}/reply`,
        body: feishuReplyBody(reply),
      });
    } catch (error) {
      if (error instanceof FeishuApiError && error.code !== null) {
        const gone = FEISHU_GONE_CODES.get(error.code);
        if (gone !== undefined) throw new ReplyGoneError(`${gone} (code ${String(error.code)})`);
      }
      throw error;
    }
    return typeof data.message_id === "string" ? { id: data.message_id } : {};
  }
}
