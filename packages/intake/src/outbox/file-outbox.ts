/**
 * A durable reply queue in intake's own state directory (ADR 0030 §6).
 *
 * One JSON file per reply, named by a sortable sequence number, so queue order
 * survives a restart and a crash mid-write loses nothing: every write goes to a
 * temporary file and is renamed into place.
 *
 * Each reply is sent once. `enqueue` ignores a key it already holds, whether
 * the reply is queued, sent, or dropped, and sent and dropped records are kept
 * for two weeks so a rescan of the rooms cannot send the same answer twice.
 *
 * Replies to one conversation go out in order. A reply waits while an earlier
 * one to the same conversation is unsent, unless that one has already failed
 * three times: a stuck reply is reported, not allowed to silence the chat.
 */

import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { describeError } from "@oguri/core";

import { writeJsonAtomic } from "./json-file.ts";
import { ReplyGoneError, type ReplySender } from "./sender.ts";
import type { OutboundReply, Outbox } from "./types.ts";

export const OUTBOX_DIR = "outbox";
/** Sent and dropped records are kept this long, so a rescan cannot resend them. */
export const OUTBOX_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const FIRST_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 300_000;
/** Consecutive failures after which a reply is a problem and stops holding its conversation. */
export const PROBLEM_AFTER = 3;

const SEQUENCE_WIDTH = 12;
const RECORD_FILE = /^(\d{12})\.json$/;

export type OutboxState = "queued" | "sent" | "dropped";

/** One reply as it sits on disk. */
export interface OutboxRecord {
  seq: number;
  reply: OutboundReply;
  state: OutboxState;
  enqueuedAt: string;
  /** Consecutive failed sends. */
  failures: number;
  /** Earliest time of the next attempt, after a failure. */
  nextAt?: string;
  lastError?: string;
  sentAt?: string;
  /** The source's id for the reply, when it returned one. */
  sentId?: string;
  dropped?: { at: string; reason: string };
}

export interface OutboxProblem {
  key: string;
  source: string;
  conversation: string;
  failures: number;
  error: string;
  nextAt: string;
}

export interface OutboxStatus {
  queued: number;
  sent: number;
  dropped: number;
  /** Replies that failed at least three times in a row; still retried. */
  problems: OutboxProblem[];
  /** Dropped replies still on record, newest first. */
  drops: { key: string; conversation: string; at: string; reason: string }[];
}

export interface FileOutboxOptions {
  /** The intake state directory; the queue lives in its `outbox/` subdirectory. */
  stateDir: string;
  /** One sender per source, such as `feishu`. */
  senders: Readonly<Record<string, ReplySender>>;
  now?: () => number;
}

/** 5s, 10s, 20s, … up to five minutes. */
export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
}

function conversationOf(reply: OutboundReply): string {
  return `${reply.source}\n${reply.conversation}`;
}

function isReply(value: unknown): value is OutboundReply {
  const reply = value as Partial<OutboundReply> | null;
  return (
    reply !== null &&
    typeof reply === "object" &&
    typeof reply.key === "string" &&
    typeof reply.source === "string" &&
    typeof reply.conversation === "string" &&
    typeof reply.replyTo === "string" &&
    typeof reply.text === "string" &&
    typeof reply.purpose === "string"
  );
}

export class FileOutbox implements Outbox {
  readonly dir: string;
  private readonly senders: Readonly<Record<string, ReplySender>>;
  private readonly now: () => number;
  private records: Map<string, OutboxRecord> | null = null;
  private nextSeq = 1;
  /** Serialises every operation, so a flush and an enqueue never interleave writes. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: FileOutboxOptions) {
    this.dir = join(options.stateDir, OUTBOX_DIR);
    this.senders = options.senders;
    this.now = options.now ?? Date.now;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async enqueue(reply: OutboundReply): Promise<void> {
    await this.serial(async () => {
      const records = await this.load();
      if (records.has(reply.key)) return;
      const record: OutboxRecord = {
        seq: this.nextSeq,
        reply: { ...reply },
        state: "queued",
        enqueuedAt: new Date(this.now()).toISOString(),
        failures: 0,
      };
      this.nextSeq += 1;
      await this.write(record);
      records.set(reply.key, record);
    });
  }

  /** Send every due reply, in queue order and in order per conversation. */
  async flush(signal?: AbortSignal): Promise<void> {
    await this.serial(async () => {
      const records = await this.load();
      await this.prune(records);
      const queued = [...records.values()]
        .filter((record) => record.state === "queued")
        .sort((a, b) => a.seq - b.seq);
      // A conversation is held once a reply to it cannot go out this pass.
      const held = new Set<string>();
      for (const record of queued) {
        if (signal?.aborted === true) return;
        const conversation = conversationOf(record.reply);
        if (held.has(conversation)) continue;
        const holds = record.failures < PROBLEM_AFTER;
        if (record.nextAt !== undefined && Date.parse(record.nextAt) > this.now()) {
          if (holds) held.add(conversation);
          continue;
        }
        const sent = await this.attempt(record);
        if (!sent && record.state === "queued" && record.failures < PROBLEM_AFTER) {
          held.add(conversation);
        }
      }
    });
  }

  /** Counts, the replies that keep failing, and what was dropped. */
  async status(): Promise<OutboxStatus> {
    return await this.serial(async () => {
      const records = [...(await this.load()).values()];
      const count = (state: OutboxState): number =>
        records.filter((record) => record.state === state).length;
      return {
        queued: count("queued"),
        sent: count("sent"),
        dropped: count("dropped"),
        problems: records
          .filter((record) => record.state === "queued" && record.failures >= PROBLEM_AFTER)
          .sort((a, b) => a.seq - b.seq)
          .map((record) => ({
            key: record.reply.key,
            source: record.reply.source,
            conversation: record.reply.conversation,
            failures: record.failures,
            error: record.lastError ?? "unknown error",
            nextAt: record.nextAt ?? record.enqueuedAt,
          })),
        drops: records
          .filter((record) => record.dropped !== undefined)
          .sort((a, b) => b.seq - a.seq)
          .map((record) => ({
            key: record.reply.key,
            conversation: record.reply.conversation,
            at: record.dropped?.at ?? "",
            reason: record.dropped?.reason ?? "",
          })),
      };
    });
  }

  /** Send one reply and record the outcome. True when it went out. */
  private async attempt(record: OutboxRecord): Promise<boolean> {
    const at = new Date(this.now()).toISOString();
    const sender = this.senders[record.reply.source];
    try {
      if (sender === undefined) throw new Error(`no sender for source ${record.reply.source}`);
      const result = await sender.send(record.reply);
      record.state = "sent";
      record.sentAt = at;
      record.failures = 0;
      delete record.nextAt;
      delete record.lastError;
      if (result.id !== undefined) record.sentId = result.id;
      await this.write(record);
      return true;
    } catch (error) {
      if (error instanceof ReplyGoneError) {
        record.state = "dropped";
        record.dropped = { at, reason: error.message };
        delete record.nextAt;
      } else {
        record.failures += 1;
        record.lastError = describeError(error);
        record.nextAt = new Date(this.now() + backoffMs(record.failures)).toISOString();
      }
      await this.write(record);
      return false;
    }
  }

  /** Delete sent and dropped records past the retention window. */
  private async prune(records: Map<string, OutboxRecord>): Promise<void> {
    const cutoff = this.now() - OUTBOX_RETENTION_MS;
    for (const [key, record] of records) {
      const doneAt =
        record.state === "sent"
          ? record.sentAt
          : record.state === "dropped"
            ? record.dropped?.at
            : undefined;
      if (doneAt === undefined || Date.parse(doneAt) >= cutoff) continue;
      await rm(this.file(record.seq), { force: true });
      records.delete(key);
    }
  }

  private file(seq: number): string {
    return join(this.dir, `${String(seq).padStart(SEQUENCE_WIDTH, "0")}.json`);
  }

  private async write(record: OutboxRecord): Promise<void> {
    await writeJsonAtomic(this.file(record.seq), record);
  }

  private async load(): Promise<Map<string, OutboxRecord>> {
    if (this.records !== null) return this.records;
    const records = new Map<string, OutboxRecord>();
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const match = RECORD_FILE.exec(name);
      if (match === null) continue;
      const seq = Number(match[1]);
      this.nextSeq = Math.max(this.nextSeq, seq + 1);
      let record: OutboxRecord;
      try {
        record = JSON.parse(await readFile(join(this.dir, name), "utf8")) as OutboxRecord;
      } catch {
        // An unreadable record is skipped; its sequence number is still never reused.
        continue;
      }
      if (!isReply(record.reply) || records.has(record.reply.key)) continue;
      records.set(record.reply.key, { ...record, seq });
    }
    this.records = records;
    return records;
  }
}
