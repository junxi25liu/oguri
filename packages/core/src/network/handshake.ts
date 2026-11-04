/**
 * Presence announcements and first contact.
 *
 * Everything here is composed from other domains — joining, the agent card,
 * sync, sending, the roster — and adds only the ordering a person used to
 * drive by hand, plus the guards that keep an automatic ack from standing in
 * for a human or looping forever.
 */

import { HANDSHAKE_ACK_TAG, HANDSHAKE_TAG, MENTION_ROOM, type Message } from "@oguri/protocol";

import type { PresenceStatus } from "../agent/card.ts";
import type { AgentIdentity, NetworkConfig } from "../config.ts";
import type { InboxItem, StateDb } from "../state.ts";
import type { PresenceRow } from "./agents.ts";
import type { SendInput } from "./messaging.ts";

export interface HandshakeInput {
  /** Room to greet in. Required unless `ackTo` is given, which implies one. */
  room?: string;
  /** Agents to address. Defaults to `@room` — everyone subscribed. */
  peers?: string[];
  /** A line of context appended to the greeting. */
  note?: string;
  /** Answer this handshake rather than opening one. */
  ackTo?: string;
}

/** Another agent on the network, with presence as observed right now. */
export interface HandshakePeer {
  id: string;
  status: PresenceStatus;
  lastSeen: string;
  /** Newest message this peer wrote in a room we subscribe to, if any. */
  lastActivity: string | null;
  tool: string;
  human: string;
}

export interface HandshakeResult {
  room: string;
  /** The thread to watch for the other side's reply. */
  thread: string;
  message: Message;
  role: "open" | "ack";
  /** Who the greeting was addressed to; `['@room']` when unaddressed. */
  addressed: string[];
  peers: HandshakePeer[];
  /**
   * Whether this run actually stamped the card.
   *
   * False means the card already read as live — the network was told nothing
   * new, which is a success, not a failure.
   */
  presencePublished: boolean;
  /**
   * Whether the pre-greeting sync reached the remote.
   *
   * False means the greeting is queued rather than sent and `peers` was read
   * from a possibly stale local roster. Reported instead of thrown: a handshake
   * opened offline is delayed, not lost.
   */
  synced: boolean;
}

/** What first contact needs from the network, and nothing more. */
export interface HandshakeContext {
  readonly identity: AgentIdentity;
  /** The config object itself, so subscriptions are read live. */
  readonly config: NetworkConfig;
  readonly state: StateDb;
  joinRoom(roomId: string): Promise<void>;
  publishAgentCard(extras: { presence?: "live" | "away"; session?: string }): Promise<boolean>;
  sync(): Promise<unknown>;
  send(roomId: string, input: SendInput): Promise<Message>;
  presenceRoster(): Promise<PresenceRow[]>;
}

/**
 * Stamp this agent as seen, without sending anything.
 *
 * What `live` asserts is narrow and worth stating: *an agent session
 * announced itself at this timestamp*. Nothing here keeps that true
 * afterwards — readers age the stamp themselves (`observedPresenceStatus`),
 * so it reads live for a few minutes and away once it has gone cold. There is
 * no heartbeat, so announcing again while the stamp is still fresh writes
 * nothing at all.
 *
 * `away` is the other direction and stays a deliberate declaration: it says
 * "I am leaving now" rather than waiting for silence to say it.
 *
 * Like every presence signal in oguri it is cooperative, not authenticated.
 */
export async function announce(
  ctx: HandshakeContext,
  status: "live" | "away",
  options: { session?: string } = {},
): Promise<boolean> {
  return await ctx.publishAgentCard({
    presence: status,
    ...(options.session === undefined ? {} : { session: options.session }),
  });
}

/**
 * Open — or answer — a first-contact exchange.
 *
 * The problem this solves is not sending a message; it is that establishing
 * contact took a person driving both machines. Every step below is one a
 * human previously had to remember: say you are here, make sure the room is
 * actually subscribed, pull before you look, greet, then report who is around
 * to answer.
 *
 * Deliberately NOT part of this: waiting. This method returns as soon as the
 * greeting is durable, and the caller watches `thread` for the reply. Waiting
 * inline would either block a session for as long as the peer's human is
 * asleep, or impose a timeout that is wrong for a network spanning
 * timezones (ADR 0026 — nothing here starts the other side unless a worker is enabled).
 *
 * Not wrapped in the repository lock: `joinRoom`, `publishAgentCard`, `sync`
 * and `send` each take it in turn, and the lock is not reentrant.
 */
export async function handshake(
  ctx: HandshakeContext,
  input: HandshakeInput = {},
): Promise<HandshakeResult> {
  const ack = input.ackTo === undefined ? null : requireHandshakeParent(ctx, input.ackTo);
  const roomId = ack?.room ?? input.room;
  if (roomId === undefined) {
    throw new Error("handshake needs a room, or a handshake message id to answer");
  }

  if (!ctx.config.subscriptions.includes(roomId)) await ctx.joinRoom(roomId);

  const presencePublished = await announce(ctx, "live");

  // Best effort: an unreachable remote must not stop the greeting. `send`
  // queues to the outbox when it cannot push, so a handshake opened offline
  // still goes out on reconnect — it just reports a roster that may be stale.
  let synced = true;
  try {
    await ctx.sync();
  } catch {
    synced = false;
  }

  const addressed = ack !== null ? [ack.from] : (input.peers ?? [MENTION_ROOM]);
  const message = await ctx.send(roomId, {
    body: handshakeBody(ctx, ack, input.note),
    kind: ack !== null ? "answer" : "question",
    // An opening asks the other agent for one thing it can answer by itself.
    // `needs: human` would park first contact on a person, which is the
    // manual step this exists to remove.
    needs: ack !== null ? "none" : "agent",
    mentions: addressed,
    tags: [ack !== null ? HANDSHAKE_ACK_TAG : HANDSHAKE_TAG],
    ...(ack === null ? {} : { inReplyTo: ack.id, thread: ack.thread }),
  });

  if (ack !== null) ctx.state.markProcessed([ack.id]);

  const self = ctx.identity.id;
  // Activity-corrected, so a peer that is mid-task does not read as absent
  // and provoke "nobody is live — do not wait on it".
  const peers: HandshakePeer[] = (await ctx.presenceRoster())
    .filter((row) => row.id !== self)
    .map((row) => ({
      id: row.id,
      status: row.status,
      lastSeen: row.lastSeen,
      lastActivity: row.lastActivity,
      tool: row.tool,
      human: row.human,
    }));

  return {
    room: roomId,
    thread: message.header.thread,
    message,
    role: ack !== null ? "ack" : "open",
    addressed,
    peers,
    presencePublished,
    synced,
  };
}

/**
 * Resolve the message an ack answers, refusing anything that is not an open
 * handshake addressed to this agent.
 *
 * Both refusals are load-bearing. Acking a `needs: human` item would let an
 * automated reply stand in for a person's decision, which is exactly what
 * ADR 0012 forbids — and it would do it silently, because an ack is sent
 * without anyone reading the question. Requiring the opening tag is what
 * stops the exchange looping: an ack is itself tagged, so an agent that
 * auto-acked anything would answer the answer, forever.
 */
function requireHandshakeParent(ctx: HandshakeContext, messageId: string): InboxItem {
  const item = ctx.state
    .listInbox({ includeProcessed: true })
    .find((candidate) => candidate.id === messageId);
  if (item === undefined) throw new Error(`no message ${messageId} in this agent's inbox`);

  if (item.needs === "human") {
    throw new Error(
      `message ${messageId} is marked 'needs: human' and will not be answered by a handshake. ` +
        `Surface it to a person and relay their words with ` +
        `'oguri answer ${messageId} "<their words>" --as-human'.`,
    );
  }
  if (!item.tags.includes(HANDSHAKE_TAG)) {
    throw new Error(
      `message ${messageId} is not an open handshake (tags: ${
        item.tags.length === 0 ? "none" : item.tags.join(", ")
      }). Reply to it with 'oguri answer ${messageId} "<your reply>"' instead.`,
    );
  }
  return item;
}

function handshakeBody(
  ctx: HandshakeContext,
  ack: InboxItem | null,
  note: string | undefined,
): string {
  const who =
    `${ctx.identity.id} · ${ctx.identity.tool} · ` +
    `${ctx.identity.human.name} · ${ctx.identity.human.timezone}`;
  const lead =
    ack === null
      ? `handshake — ${who}\n\nFirst contact: checking that messages reach this network and come back.`
      : `handshake ack — ${who}\n\nHeard ${ack.from} in #${ack.room}. This link works in both directions.`;
  return note === undefined || note.trim() === "" ? lead : `${lead}\n\n${note.trim()}`;
}
