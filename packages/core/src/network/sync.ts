/**
 * Pulling the network into this machine, and what a pull noticed on the way.
 *
 * Change detection is `../sync/detector.ts` and routing `../sync/routing.ts`,
 * both pure; this is the half that drains the outboxes, fetches, verifies and
 * delivers, and records whether the transport can still be trusted.
 *
 * It also keeps the ambient record — rooms this agent does not follow, and
 * conversations that started beside it — because both arrive with data a sync
 * has already fetched, and noticing them anywhere else would cost a round trip.
 */

import { join } from "node:path";

import { MAIN_REF, isThreadRoot, messagePath, roomRef, type Message } from "@oguri/protocol";

import type { AgentCard } from "../agent/card.ts";
import type { AgentIdentity, NetworkConfig } from "../config.ts";
import { describeError, firstMeaningfulLine } from "../errors.ts";
import { exists } from "../fs.ts";
import { FileLock } from "../lock.ts";
import type { Repo } from "../git/repo.ts";
import { verifyMessage, type Verification } from "../authenticity.ts";
import type { AuthenticityMode } from "../net.ts";
import type { StateDb } from "../state.ts";
import {
  collectRoomUpdate,
  diffRoomHeads,
  type Anomaly,
  type RoomChange,
} from "../sync/detector.ts";
import { shouldDeliverMessage } from "../sync/routing.ts";

const REMOTE = "origin";

/** Rooms this agent does not follow, keyed by id → last seen head. */
export const SEEN_ROOMS_KEY = "seenRooms";
/** Conversations that started beside this agent, oldest first. */
export const STARTED_THREADS_KEY = "startedThreads";
/**
 * How many of those to remember.
 *
 * Small on purpose: this is a hint that a discussion exists, not an archive of
 * one. The room itself is the record, and `oguri read <room>` is one call away.
 */
const MAX_REMEMBERED_THREADS = 50;

export function readJsonMeta<T>(state: StateDb, key: string, fallback: T): T {
  const raw = state.getMeta(key);
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Advisory data written by an older build, or corrupted. Never worth an
    // error on a read path that only adds context.
    return fallback;
  }
}

/** A remembered thread start, with when this machine noticed it. */
export interface StoredThreadStart extends ThreadStart {
  at: string;
}

/** A room on the network this agent does not follow. */
export interface RoomDiscovery {
  roomId: string;
  /**
   * `appeared` the first time this machine ever saw the room; `active`
   * afterwards, when its branch moved again.
   *
   * The distinction is what a reader acts on: a room that appeared is a place
   * the team decided to start, and joining it is a decision. A room that is
   * merely active has been there all along.
   */
  state: "appeared" | "active";
}

/** A conversation opened in a followed room, addressed to somebody else. */
export interface ThreadStart {
  room: string;
  /** The thread root's id — `oguri read <room> --thread <id>` opens it. */
  thread: string;
  from: string;
  kind: string;
  needs: string;
  /** Who it WAS addressed to, so a reader can tell whether it concerns them. */
  mentions: string[];
}

export interface SyncReport {
  roomsPolled: number;
  changed: RoomChange[];
  recorded: number;
  delivered: number;
  /**
   * The messages that actually landed in this agent's inbox.
   *
   * Carried on the report so the daemon can decide what deserves a
   * notification without re-querying and diffing the inbox — routing already
   * computed this.
   */
  deliveredMessages: Message[];
  /** Rooms whose queued-while-offline commits were pushed by this sync. */
  drained: { roomId: string; pushed: number }[];
  /**
   * Messages whose author could not be verified under the network's
   * authenticity mode. Delivered anyway, with a warning: silently dropping
   * them would let an attacker suppress traffic (spec §10).
   */
  unverified: { id: string; from: string; room: string; reason: string }[];
  anomalies: Anomaly[];
  unreadable: { path: string; error: unknown }[];
  /**
   * What is happening on the network **outside** this agent's inbox.
   *
   * An agent that joined `general` and waits sees only what was addressed to
   * it, so a room created this morning and the conversation the team started in
   * it are invisible — not filtered out, never mentioned. Waiting looks the
   * same as there being nothing to know, and the agent finds out when someone
   * eventually complains it was not there.
   *
   * Both of these cost **nothing extra**: the room list arrives with the same
   * `ls-remote` every poll already makes, and the thread roots are messages this
   * sync fetched and parsed anyway. Neither changes routing or the inbox — they
   * are ambient awareness, and a reader decides whether to act.
   */
  discovered: RoomDiscovery[];
  /** Conversations that started in a followed room without addressing us. */
  startedThreads: ThreadStart[];
}

/**
 * Whether this agent's view of the network can be trusted right now.
 *
 * Carried on every read, because a read answers from a local cache that cannot
 * distinguish "nothing was said" from "nothing has reached this machine since
 * Tuesday".
 */
export interface TransportHealth {
  /** When sync last completed. Null means it never has. */
  lastSyncAt: string | null;
  /** Seconds since that, or null if it never synced. */
  ageSeconds: number | null;
  /** True when sync is failing, or has never run. Treat results as partial. */
  degraded: boolean;
  /** Why, when known — the message from the failure sync recorded. */
  reason?: string;
  /** When it started failing, so a reader sees how long this has been true. */
  failingSince?: string;
}

/**
 * Shorten a sync failure to the part someone can act on.
 *
 * A raw `GitError` carries the whole command line and every line of git's
 * stderr. Carried verbatim into a health warning it buries the one useful
 * sentence and bloats every JSON read that reports it, so keep the diagnosis
 * and drop the transcript.
 */
export function conciseFailure(error: unknown): string {
  // Report what the transport said, not what oguri concluded from it. A push
  // that exhausts its ladder wraps the real failure as its `cause`, and "push
  // did not converge after 3 attempts" tells a user nothing they can act on,
  // while "Permission denied (publickey)" tells them exactly what to fix.
  const root = (error as { cause?: unknown } | null)?.cause;
  const full = describeError(root ?? error);
  // `git <flags...> failed (128): fatal: ...` — the flags are ours, not news.
  const detail = /failed \(\d+\): ([\s\S]+)$/.exec(full)?.[1] ?? full;
  const trimmed = (firstMeaningfulLine(detail) ?? detail).trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}

/** What sync needs from the network, and nothing more. */
export interface SyncContext {
  readonly identity: AgentIdentity;
  /** The config object itself, so subscriptions are read live, under the lock. */
  readonly config: NetworkConfig;
  readonly repo: Repo;
  readonly state: StateDb;
  readonly recordWorktree: string;
  readonly lockPath: string;
  drainRecordOutbox(): Promise<void>;
  drainOutbox(): Promise<{ roomId: string; pushed: number }[]>;
  authenticityMode(): Promise<AuthenticityMode>;
  listAgents(): Promise<AgentCard[]>;
  ensureRoomWorktree(roomId: string): Promise<string>;
}

/** Reading health needs only what sync recorded. */
export type HealthContext = Pick<SyncContext, "state">;

/**
 * Whether this agent's view of the network can be trusted right now.
 *
 * Reads answer from the local cache, so a transport that has stopped working
 * produces an empty inbox rather than an error — and an agent reports "no new
 * messages" to its human while dozens sit unfetched on the remote. That
 * happened. The cache cannot tell the difference on its own, so sync records
 * whether it last succeeded and every read carries the answer.
 */
export function health(ctx: HealthContext, now = Date.now()): TransportHealth {
  // `setMeta(key, "")` is how a value is cleared, and `getMeta` returns that
  // empty string rather than null — so an emptied key must read as absent or
  // the first success would leave the network degraded forever.
  const meta = (key: string): string | null => {
    const value = ctx.state.getMeta(key);
    return value === null || value === "" ? null : value;
  };
  const lastSyncAt = meta("lastSyncAt");
  const failure = meta("lastSyncError");
  const failedAt = meta("lastSyncErrorAt");
  const syncedMs = lastSyncAt === null ? null : Date.parse(lastSyncAt);
  const ageSeconds =
    syncedMs === null || !Number.isFinite(syncedMs)
      ? null
      : Math.max(0, Math.round((now - syncedMs) / 1000));

  return {
    lastSyncAt,
    ageSeconds,
    // Never synced is not "fine, nothing to report" — it is the state in which
    // an empty inbox is least trustworthy.
    degraded: failure !== null || lastSyncAt === null,
    ...(failure === null ? {} : { reason: failure }),
    ...(failedAt === null ? {} : { failingSince: failedAt }),
  };
}

export async function sync(ctx: SyncContext): Promise<SyncReport> {
  try {
    return await syncOnce(ctx);
  } catch (error) {
    // Record before rethrowing. The caller may swallow this — a daemon logs
    // and retries, an editor may show nothing — and the whole point is that
    // the next READ can still tell someone the view is not to be trusted.
    try {
      ctx.state.setMeta("lastSyncError", conciseFailure(error));
      // Keep the FIRST failure time, so a reader learns how long this has
      // been broken rather than only that it is broken now. A cleared key
      // reads as "" rather than null, so both count as "no failure yet".
      const since = ctx.state.getMeta("lastSyncErrorAt");
      if (since === null || since === "") {
        ctx.state.setMeta("lastSyncErrorAt", new Date().toISOString());
      }
    } catch {
      // A closed database during shutdown must not replace the real error.
    }
    throw error;
  }
}

async function syncOnce(ctx: SyncContext): Promise<SyncReport> {
  return await FileLock.withLock(ctx.lockPath, async () => {
    const subscribed = new Set(ctx.config.subscriptions);
    // Anything queued while offline goes out before we pull, so a reconnect
    // delivers this agent's backlog rather than only fetching everyone else's.
    await ctx.drainRecordOutbox();
    const drained = await ctx.drainOutbox();
    const remote = await ctx.repo.lsRemoteHeads(ctx.config.remote);
    const diff = diffRoomHeads(ctx.state.allHeads(), remote.rooms, subscribed);

    const report: SyncReport = {
      roomsPolled: remote.rooms.size,
      changed: diff.changed,
      recorded: 0,
      delivered: 0,
      deliveredMessages: [],
      drained,
      unverified: [],
      anomalies: [],
      unreadable: [],
      discovered: noteUnsubscribedRooms(ctx, diff.unsubscribed, remote.rooms),
      startedThreads: [],
    };

    // Agent cards, profiles, and room policy live on main. Refresh it before verifying
    // or routing room messages, but only when its advertised SHA changed.
    // Previously every healthy poll fetched main even when it was identical,
    // doubling remote pressure for a quiet shared room.
    if (remote.main !== null) {
      const trackedMain = `refs/remotes/${REMOTE}/${MAIN_REF}`;
      if ((await ctx.repo.resolveRef(trackedMain)) !== remote.main) {
        await ctx.repo
          .fetch(ctx.config.remote, [`+refs/heads/${MAIN_REF}:${trackedMain}`])
          .catch(() => undefined);
      }
      if ((await ctx.repo.resolveRef(`refs/heads/${MAIN_REF}`)) !== remote.main) {
        // Fast-forward only when there is no durable local record commit to
        // publish. A divergent local commit belongs to the record outbox and
        // must be rebased/pushed, never discarded.
        const ahead = await ctx.repo.aheadCount(ctx.recordWorktree, trackedMain);
        if (ahead === 0) {
          await ctx.repo.fastForward(ctx.recordWorktree, trackedMain).catch(() => undefined);
        }
      }
    }

    // A multi-room burst shares the same policy/card snapshot. Reading and
    // parsing the roster once keeps local work proportional to messages, not
    // `changed rooms × registered agents`.
    const mode = diff.changed.length === 0 ? "none" : await ctx.authenticityMode();
    const cards = mode === "none" ? [] : await ctx.listAgents();
    const cardById = new Map(cards.map((card) => [card.id, card]));
    const signersPath = join(ctx.recordWorktree, ".oguri/allowed_signers");
    const haveSigners = mode === "signed" && (await exists(signersPath));

    for (const change of diff.changed) {
      const ref = roomRef(change.roomId);
      await ctx.repo.fetch(ctx.config.remote, [`+refs/heads/${ref}:refs/remotes/${REMOTE}/${ref}`]);
      const worktree = await ctx.ensureRoomWorktree(change.roomId);
      await ctx.repo.fastForward(worktree, `refs/remotes/${REMOTE}/${ref}`);

      const update = await collectRoomUpdate(ctx.repo, change);
      report.recorded += update.messages.length;
      report.anomalies.push(...update.anomalies);
      report.unreadable.push(...update.unreadable);

      for (const message of update.messages) {
        if (mode !== "none") {
          const verification: Verification = await verifyMessage(mode, {
            message,
            commitAuthorEmail: update.commitAuthors.get(message.header.id) ?? null,
            card: cardById.get(message.header.from),
            allowedSignersPath: haveSigners ? signersPath : null,
          });
          if (!verification.verified) {
            report.unverified.push({
              id: message.header.id,
              from: message.header.from,
              room: message.header.room,
              reason: verification.reason ?? "unverified",
            });
          }
        }

        if (shouldDeliver(ctx, message, subscribed)) {
          ctx.state.addToInbox(message, messagePath(message.header));
          report.delivered += 1;
          report.deliveredMessages.push(message);
        } else if (isThreadRoot(message.header) && message.header.from !== ctx.identity.id) {
          // Recorded, not delivered — somebody opened a conversation in a room
          // this agent follows and addressed it elsewhere. Routing is right to
          // keep it out of the inbox, but "a discussion started next to you"
          // is the thing a waiting agent has no other way to learn. Roots
          // only: every reply after this belongs to a thread already named.
          report.startedThreads.push({
            room: message.header.room,
            thread: message.header.thread,
            from: message.header.from,
            kind: message.header.kind,
            needs: message.header.needs,
            mentions: [...message.header.mentions],
          });
        }
      }
      ctx.state.setHead(change.roomId, change.to);
    }

    noteStartedThreads(ctx, report.startedThreads);
    ctx.state.setMeta("lastSyncAt", new Date().toISOString());
    // A sync that got this far worked, so the transport is trustworthy again.
    ctx.state.setMeta("lastSyncError", "");
    ctx.state.setMeta("lastSyncErrorAt", "");
    return report;
  });
}

/**
 * Track rooms this agent does not follow, so each is news exactly once.
 *
 * Kept in `meta` rather than in the delivery head table on purpose. Those
 * heads mean "everything up to here has been processed for delivery", and
 * writing one for a room nobody has joined would silently skip that room's
 * entire backlog on the day someone did join it. `meta` also survives a
 * schema bump, so noticing rooms never costs anyone a re-delivered inbox.
 */
function noteUnsubscribedRooms(
  ctx: SyncContext,
  unsubscribed: readonly string[],
  remote: ReadonlyMap<string, string>,
): RoomDiscovery[] {
  const known = readJsonMeta<Record<string, string>>(ctx.state, SEEN_ROOMS_KEY, {});
  const discovered: RoomDiscovery[] = [];
  const next: Record<string, string> = {};
  for (const roomId of unsubscribed) {
    const head = remote.get(roomId);
    if (head === undefined) continue;
    next[roomId] = head;
    const previous = known[roomId];
    if (previous === head) continue;
    discovered.push({ roomId, state: previous === undefined ? "appeared" : "active" });
  }
  // Replaced rather than merged: a room this agent has since joined belongs
  // to delivery now, and one that vanished is not news any more.
  ctx.state.setMeta(SEEN_ROOMS_KEY, JSON.stringify(next));
  return discovered;
}

/**
 * Remember conversations that started beside this agent, newest last.
 *
 * Bounded and advisory. This is context, not mail: it never gates delivery,
 * and losing it costs nothing, so it lives in `meta` instead of earning a
 * schema bump that would make every existing install re-deliver its inbox.
 */
function noteStartedThreads(
  ctx: SyncContext,
  started: readonly ThreadStart[],
  now = new Date(),
): void {
  if (started.length === 0) return;
  const at = now.toISOString();
  const kept = [
    ...readJsonMeta<StoredThreadStart[]>(ctx.state, STARTED_THREADS_KEY, []).filter(
      (entry) => !started.some((fresh) => fresh.thread === entry.thread),
    ),
    ...started.map((start) => ({ ...start, at })),
  ];
  ctx.state.setMeta(
    STARTED_THREADS_KEY,
    JSON.stringify(kept.slice(Math.max(0, kept.length - MAX_REMEMBERED_THREADS))),
  );
}

/**
 * Routing (delivery §2).
 *
 * Everything is recorded in the room regardless; this decides only what lands
 * in the inbox and can raise a notification. Conflating the two makes a
 * system either noisy or lossy.
 */
function shouldDeliver(
  ctx: SyncContext,
  message: Message,
  subscribed: ReadonlySet<string>,
): boolean {
  return shouldDeliverMessage(message, ctx.identity.id, subscribed, ctx.identity.machine.id);
}
