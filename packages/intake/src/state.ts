/**
 * Intake's local state: read positions, the bot's identity, and which chat
 * threads belong to which task (ADR 0030).
 *
 * Lives in `<OGURI_HOME>/intake/state.json`, written atomically. It is a
 * cache, like `state.db`: the read positions are the one thing git cannot
 * give back, and losing them costs at most a fresh start at "now". The task
 * map and the dedupe set are rebuilt from the rooms at start-up, so a deleted
 * or stale file never creates a second task for one message.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { externalKey, type Message } from "@oguri/protocol";
import type { TaskStatus } from "@oguri/core";

/** Where a chat thread's messages go: one task, in one room. */
export interface TaskLink {
  network: string;
  room: string;
  taskId: string;
  /** The task's oguri thread, which follow-ups join. */
  threadRoot: string;
}

/** The newest message read in one chat, and every id read at that millisecond. */
export interface ChatCursor {
  ms: number;
  ids: string[];
}

export interface IntakeStatus {
  startedAt?: string;
  pid?: number;
  lastPollAt?: string;
  lastError?: { at: string; message: string };
  /** Who holds the intake claim, as of the last poll. */
  claim?: { resource: string; room: string; holder: string; mine: boolean; at: string };
  /** Why the last poll did nothing, such as "disabled" or a claim held elsewhere. */
  idle?: string;
  backoffUntil?: string;
}

export interface IntakeStateData {
  v: 1;
  /** The app the bot identity and chat details below belong to. */
  appId?: string;
  botId?: string;
  botName?: string;
  cursors: Record<string, ChatCursor>;
  chats: Record<string, { mode?: string; name?: string }>;
  /** Feishu message or thread id → task. */
  tasks: Record<string, TaskLink>;
  status: IntakeStatus;
}

/** How far back the dedupe set looks. A message older than this is never polled again. */
export const DEDUPE_WINDOW_MS = 14 * 24 * 60 * 60_000;

export function intakeDir(home: string): string {
  return join(home, "intake");
}

export function emptyState(): IntakeStateData {
  return { v: 1, cursors: {}, chats: {}, tasks: {}, status: {} };
}

/** Read the state file. A missing or unreadable file is a fresh start. */
export async function readIntakeState(home: string): Promise<IntakeStateData> {
  try {
    const raw = JSON.parse(
      await readFile(join(intakeDir(home), "state.json"), "utf8"),
    ) as Partial<IntakeStateData>;
    if (raw === null || typeof raw !== "object" || raw.v !== 1) return emptyState();
    return {
      ...emptyState(),
      ...raw,
      cursors: { ...raw.cursors },
      chats: { ...raw.chats },
      tasks: { ...raw.tasks },
      status: { ...raw.status },
    };
  } catch {
    return emptyState();
  }
}

let writes = 0;

/** Write the state file atomically: a reader sees the old file or the new one, never half. */
export async function writeIntakeState(home: string, state: IntakeStateData): Promise<void> {
  const dir = intakeDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "state.json");
  writes += 1;
  const temp = `${target}.${String(process.pid)}-${String(writes)}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

/**
 * Link a task to the chat message that asked for it, and to its chat thread.
 *
 * The message id always maps. The thread maps only when no earlier task owns
 * it: a person who asks twice in one reply chain keeps following up on the
 * first task, and the second is reached through a reply to its own message.
 */
export function linkTask(
  tasks: Record<string, TaskLink>,
  origin: { message: string; thread?: string },
  link: TaskLink,
): void {
  tasks[origin.message] = link;
  if (origin.thread !== undefined && tasks[origin.thread] === undefined) {
    tasks[origin.thread] = link;
  }
}

/** The task a chat message follows up on: the message it replies to first, then its thread. */
export function findTask(
  tasks: Readonly<Record<string, TaskLink>>,
  keys: readonly (string | undefined)[],
): TaskLink | undefined {
  for (const key of keys) {
    if (key === undefined) continue;
    const link = tasks[key];
    if (link !== undefined) return link;
  }
  return undefined;
}

/** Rebuild the task map from the tasks intake created, oldest first. */
export function rebuildTaskMap(
  rooms: readonly { room: string; tasks: readonly TaskStatus[] }[],
  network: string,
  source = "feishu",
): Record<string, TaskLink> {
  const found: { at: string; origin: { message: string; thread?: string }; link: TaskLink }[] = [];
  for (const { room, tasks } of rooms) {
    for (const status of tasks) {
      const origin = status.task.origin;
      if (origin?.source !== source) continue;
      found.push({
        at: status.rootMessageId,
        origin,
        link: { network, room, taskId: status.task.id, threadRoot: status.thread },
      });
    }
  }
  // Root message ids are ULIDs, so their order is creation order.
  found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const map: Record<string, TaskLink> = {};
  for (const entry of found) linkTask(map, entry.origin, entry.link);
  return map;
}

/**
 * The outside messages a room already relays, as dedupe keys: every
 * `external` header, and the origin of every task, within the window.
 */
export function relayedKeys(messages: readonly Message[], now: number): Set<string> {
  const keys = new Set<string>();
  const since = now - DEDUPE_WINDOW_MS;
  for (const message of messages) {
    const at = Date.parse(message.header.ts);
    if (Number.isFinite(at) && at < since) continue;
    if (message.header.external !== undefined) keys.add(externalKey(message.header.external));
    const origin = message.header.task?.origin;
    if (origin !== undefined) keys.add(externalKey({ source: origin.source, id: origin.message }));
  }
  return keys;
}
