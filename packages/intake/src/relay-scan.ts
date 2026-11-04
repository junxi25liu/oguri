/**
 * Find the replies a room's messages owe the chat, and queue them (ADR 0030 §6, §7).
 *
 * Two kinds. A message in a task thread that carries `relay` goes back as
 * written. A task with an `origin` that completes, or blocks for a person,
 * without its agent writing the matching relay still gets one, built from the
 * event itself: the person who asked hears the outcome even when the agent
 * forgot to say it.
 *
 * Cheap to call every poll. Each room keeps a high-water mark in
 * `relay-cursor.json`, and only messages from a day before it onward are
 * looked at. The day of overlap catches a message minted on another machine
 * before the mark but pushed after it; the outbox's dedupe by key makes the
 * overlap free. A room seen for the first time starts at `since`, so starting
 * intake on an old room does not replay its history into the chat.
 */

import { join } from "node:path";

import { reduceTaskDetail, reduceTasks, type TaskStatus } from "@oguri/core";
import { compareUlid, isUlid, ulidTime, type Message, type RelayPurpose } from "@oguri/protocol";

import { readJson, writeJsonAtomic } from "./outbox/json-file.ts";
import type { OutboundReply, Outbox } from "./outbox/types.ts";
import { composeReply, relaysFor } from "./relay.ts";
import { MERGED_NOTE, prUrlsIn } from "./github/pr-follow.ts";

export const RELAY_CURSOR_FILE = "relay-cursor.json";
/** How far behind its mark a room is rescanned, for messages pushed late. */
export const RESCAN_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * How long after a task completes or blocks before intake speaks for it.
 * The agent usually writes its own relay beside the event; this gives that
 * message time to arrive in a later push before intake writes a second one.
 */
export const AUTO_GRACE_MS = 60_000;
/** An automatic result is a summary, not a transcript. */
export const AUTO_RESULT_WORDS = 100;

/** What relaying needs from oguri. `Backend` satisfies it through `relayBackend`. */
export interface RelayBackend {
  /** Every message in a room's live window. */
  read(room: string): Promise<Message[]>;
  /** Complete a task this agent holds. Throws when the transition is refused. */
  completeTask(room: string, taskId: string, body: string, refs: string[]): Promise<Message>;
}

export interface RoomCursor {
  /** The highest message id scanned. */
  last?: string;
  /** Nothing older than this (ms since the epoch) is ever relayed from this room. */
  floor: number;
}

export interface RelayCursor {
  rooms: Record<string, RoomCursor>;
}

export interface ScanOptions {
  outbox: Outbox;
  /** The intake state directory, where `relay-cursor.json` lives. */
  stateDir: string;
  maxReplyWords: number;
  now?: () => number;
}

export interface ScanReport {
  /** Replies handed to the outbox this scan, including ones it already held. */
  replies: OutboundReply[];
  /** Rooms that could not be read, with the reason. */
  failed: { room: string; error: string }[];
}

export async function readCursor(stateDir: string): Promise<RelayCursor> {
  const raw = (await readJson(join(stateDir, RELAY_CURSOR_FILE))) as Partial<RelayCursor> | null;
  const rooms: Record<string, RoomCursor> = {};
  for (const [room, entry] of Object.entries(raw?.rooms ?? {})) {
    if (typeof entry?.floor !== "number") continue;
    rooms[room] = {
      floor: entry.floor,
      ...(typeof entry.last === "string" && isUlid(entry.last) ? { last: entry.last } : {}),
    };
  }
  return { rooms };
}

/** Where a room's scan starts: a day behind its mark, never before its floor. */
function scanFrom(cursor: RoomCursor): number {
  if (cursor.last === undefined) return cursor.floor;
  return Math.max(cursor.floor, ulidTime(cursor.last) - RESCAN_LOOKBACK_MS);
}

function timeOf(id: string): number {
  return isUlid(id) ? ulidTime(id) : 0;
}

/** Drop the worker's local log pointer; the chat cannot open it. */
function withoutLogLine(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.trim().startsWith("Full log: "))
    .join("\n");
}

interface Candidate {
  order: string;
  reply: OutboundReply;
}

/**
 * The reply intake writes for a task's event when its agent wrote none:
 * `result` for a completion, `attention` for a block that needs a person.
 */
function autoReply(
  messages: readonly Message[],
  status: TaskStatus,
  options: { maxReplyWords: number; now: number; from: number },
): Candidate | null {
  const origin = status.task.origin;
  if (origin === undefined) return null;
  const eventId = status.currentMessageId;
  const at = timeOf(eventId);
  if (at < options.from || options.now - at < AUTO_GRACE_MS) return null;

  const detail = reduceTaskDetail(messages, status.task.id, options.now);
  const index = detail?.events.findIndex((event) => event.messageId === eventId) ?? -1;
  const event = index < 0 ? undefined : detail?.events[index];
  if (detail === undefined || event === undefined) return null;

  let purpose: RelayPurpose;
  if (event.action === "completed") purpose = "result";
  else if (event.action === "blocked" && event.needs === "human") purpose = "attention";
  else return null;

  // The agent's own relay may sit just before the event or anywhere after it.
  const before = detail.events[index - 1]?.messageId ?? detail.rootMessageId;
  const spoke = messages.some(
    (message) =>
      message.header.thread === status.thread &&
      message.header.relay === purpose &&
      compareUlid(message.header.id, before) > 0,
  );
  if (spoke) return null;

  const prs = prUrlsIn(event.refs);
  // Intake's own completion after a merge: the PR follower already sent its closing note.
  if (purpose === "result" && prs.some((url) => event.body.trim() === MERGED_NOTE(url))) {
    return null;
  }

  const words = Math.min(AUTO_RESULT_WORDS, options.maxReplyWords);
  const pr = purpose === "result" ? prs.find((url) => !event.body.includes(url)) : undefined;
  let text = composeReply(purpose, withoutLogLine(event.body), {
    maxWords: pr === undefined ? words : words - 1,
  });
  if (pr !== undefined && !text.startsWith("(withheld")) text = `${text} ${pr}`;
  return {
    order: eventId,
    reply: {
      key: `auto-${purpose}:${status.task.id}:${eventId}`,
      source: origin.source,
      conversation: origin.conversation,
      replyTo: origin.message,
      text,
      purpose,
      taskId: status.task.id,
    },
  };
}

/** The replies one room's messages owe, in the order they were written. */
export function roomReplies(
  messages: readonly Message[],
  from: number,
  options: { maxReplyWords: number; now: number },
): OutboundReply[] {
  const statuses = reduceTasks(messages, options.now).filter(
    (status) => status.task.origin !== undefined,
  );
  if (statuses.length === 0) return [];
  const byThread = new Map(statuses.map((status) => [status.thread, status]));
  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const candidates: Candidate[] = [];

  for (const message of messages) {
    if (message.header.relay === undefined || timeOf(message.header.id) < from) continue;
    const status = byThread.get(message.header.thread);
    if (status === undefined) continue;
    const parent =
      message.header.inReplyTo === undefined ? undefined : byId.get(message.header.inReplyTo);
    const reply = relaysFor(
      message,
      { task: status.task, thread: status.thread },
      { maxReplyWords: options.maxReplyWords, ...(parent === undefined ? {} : { parent }) },
    );
    if (reply !== null) candidates.push({ order: message.header.id, reply });
  }
  for (const status of statuses) {
    const auto = autoReply(messages, status, {
      maxReplyWords: options.maxReplyWords,
      now: options.now,
      from,
    });
    if (auto !== null) candidates.push(auto);
  }
  return candidates
    .sort((a, b) => compareUlid(a.order, b.order))
    .map((candidate) => candidate.reply);
}

/**
 * Scan rooms for owed replies and enqueue them. `since` (ms since the epoch)
 * is where a room without a cursor starts.
 */
export async function scanRelays(
  backend: Pick<RelayBackend, "read">,
  rooms: readonly string[],
  since: number,
  options: ScanOptions,
): Promise<ScanReport> {
  const now = (options.now ?? Date.now)();
  const cursor = await readCursor(options.stateDir);
  const report: ScanReport = { replies: [], failed: [] };
  let changed = false;

  for (const room of rooms) {
    const roomCursor = cursor.rooms[room] ?? { floor: since };
    if (cursor.rooms[room] === undefined) changed = true;
    let messages: Message[];
    try {
      messages = await backend.read(room);
    } catch (error) {
      report.failed.push({ room, error: error instanceof Error ? error.message : String(error) });
      cursor.rooms[room] = roomCursor;
      continue;
    }
    const replies = roomReplies(messages, scanFrom(roomCursor), {
      maxReplyWords: options.maxReplyWords,
      now,
    });
    for (const reply of replies) {
      await options.outbox.enqueue(reply);
      report.replies.push(reply);
    }
    // The mark moves only after every reply up to it is safely queued.
    const highest = messages.reduce<string | undefined>(
      (best, message) =>
        isUlid(message.header.id) &&
        (best === undefined || compareUlid(message.header.id, best) > 0)
          ? message.header.id
          : best,
      roomCursor.last,
    );
    if (highest !== roomCursor.last) changed = true;
    cursor.rooms[room] = { ...roomCursor, ...(highest === undefined ? {} : { last: highest }) };
  }
  if (changed) await writeJsonAtomic(join(options.stateDir, RELAY_CURSOR_FILE), cursor);
  return report;
}
