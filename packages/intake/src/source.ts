/**
 * Where intake reads a chat from (ADR 0030).
 *
 * A source turns one chat platform's messages into `InboundMessage`s and keeps
 * its own read position. Intake decides what each message means; the source
 * only reports what was said, by whom, and whether it addressed the bot.
 *
 * Feishu is the only source today, and it polls. The interface leaves room for
 * a push source: it still hands over batches and is told which ones were
 * handled.
 */

import type { ExternalRef } from "@oguri/protocol";

/** How a message addressed the bot: a mention in a chat, or a direct message. */
export type Addressed = "mention" | "direct";

export interface InboundMessage {
  external: ExternalRef;
  /** Plain text, with mentions of the bot removed and other mentions as `@name`. */
  text: string;
  addressed: Addressed | null;
  /** When it was written, as an ISO timestamp with milliseconds. */
  at: string;
  /** The message it replies to. */
  parent?: string;
  /** The first message of its reply chain, when the source reports one apart from `thread`. */
  root?: string;
  /** A link a person can open, when the source has one. */
  url?: string;
}

/** What a source can say about itself for `oguri intake status`. */
export interface SourceHealth {
  source: string;
  /** The bot's own identity in the source, once known. */
  botId?: string;
  lastError?: { at: string; message: string };
  /** No calls are made before this time, after a transient failure. */
  backoffUntil?: string;
  chats: { id: string; mode?: string; name?: string }[];
}

export interface IntakeSource {
  readonly name: string;
  /**
   * New messages since the stored read position, oldest first per conversation.
   * A failure is recorded in `health()` rather than thrown.
   */
  poll(signal?: AbortSignal): Promise<InboundMessage[]>;
  /**
   * Move the read position past the messages intake finished with. A message
   * returned by `poll` and not handled here is returned again by the next poll,
   * and so is everything after it in the same conversation.
   */
  commit(handled: readonly InboundMessage[]): Promise<void>;
  health(): SourceHealth;
}
