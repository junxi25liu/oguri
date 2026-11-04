import type { RelayPurpose } from "@oguri/protocol";

export interface OutboundReply {
  key: string;
  source: string;
  conversation: string;
  replyTo: string;
  text: string;
  purpose: RelayPurpose;
  taskId?: string;
}

export interface Outbox {
  enqueue(reply: OutboundReply): Promise<void>;
  flush(signal?: AbortSignal): Promise<void>;
}
