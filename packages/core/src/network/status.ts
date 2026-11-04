/**
 * The cheap summaries: where this agent stands, and what is going on beside it.
 *
 * Both answer from the local cache and what earlier syncs recorded — no fetch.
 * The one exception is the outbox count, which is a local git comparison, not
 * a network call.
 */

import { machineRoomId } from "@oguri/protocol";

import { classifyAttention, type Attention } from "../attention.ts";
import type { AgentIdentity, NetworkConfig } from "../config.ts";
import type { StateDb } from "../state.ts";
import type { Agenda, AgendaCounts, AgendaOptions } from "../task/agenda.ts";
import type { OutboxEntry } from "./outbox.ts";
import type { MachineAgentRow } from "./agents.ts";
import {
  readJsonMeta,
  SEEN_ROOMS_KEY,
  STARTED_THREADS_KEY,
  type StoredThreadStart,
  type TransportHealth,
} from "./sync.ts";

/** The network beside this agent's inbox. See `Network.surroundings`. */
export interface Surroundings {
  /** Rooms on the network this agent has not joined. */
  rooms: string[];
  /** Conversations opened in followed rooms without addressing this agent. */
  threads: StoredThreadStart[];
}

export interface NetworkStatus {
  networkId: string;
  remote: string;
  agentId: string;
  /**
   * The computer this agent runs on, and how many peers share it.
   *
   * On status because the first useful question a fresh session has is "am I
   * alone here" — and the answer changes what it should do: alone, it does the
   * work; with two live peers on the same checkout, it claims a slice and says
   * so before touching a file.
   */
  machine: { id: string; label: string; peers: number; livePeers: number; room: string };
  subscriptions: string[];
  pending: number;
  pendingHuman: number;
  /** Messages committed locally but not yet accepted by the remote. */
  queued: number;
  lastSyncAt: string | null;
  heads: Record<string, string>;
  /**
   * Unfinished collaborative work this agent is party to, across every room.
   *
   * Status answers "what is waiting for me", and until now that meant unread
   * messages only — so an agent could report a clean network while owning a
   * task that had been stalled for a week.
   */
  tasks: AgendaCounts;
  /**
   * The network beside this agent — rooms it has not joined, and conversations
   * that started in the ones it has without addressing it.
   *
   * On status because status is the cheap check an agent already makes, and
   * because "nothing is waiting for me" was previously answerable without ever
   * revealing that the team had moved somewhere else. Counts and ids, never
   * bodies; nothing here is delivery.
   */
  surroundings: Surroundings;
  /**
   * Which pending messages bear on the work in hand — ids and reasons only,
   * never bodies.
   *
   * This is what makes status safe to call part-way through long work. "Is
   * there mail" was only ever answerable by reading the mail, so an agent that
   * wanted to know whether it was needed had to accept a context switch to find
   * out it was not. See `classifyAttention`.
   */
  attention: Attention;
  /** Whether the local view can be trusted. See `TransportHealth`. */
  health: TransportHealth;
}

/** What the summaries need from the network, and nothing more. */
export interface StatusContext {
  readonly networkId: string;
  readonly identity: AgentIdentity;
  /** The config object itself, so subscriptions are read live. */
  readonly config: NetworkConfig;
  readonly state: StateDb;
  agenda(options: AgendaOptions): Promise<Agenda>;
  peers(): Promise<MachineAgentRow[]>;
  outbox(): Promise<OutboxEntry[]>;
  health(): TransportHealth;
}

/**
 * What is going on around this agent, as opposed to addressed to it.
 *
 * The gap this closes: an agent joins one room, waits, and is structurally
 * blind to everything else — routing keeps other rooms out of its inbox, and
 * a conversation started next to it was never addressed to it either. Waiting
 * therefore looks exactly like there being nothing to know, right up until
 * somebody asks why it did not join in.
 *
 * Answered entirely from what earlier syncs already recorded: no network call,
 * no git. Nothing here is delivery — it is the network saying "this exists",
 * and the agent decides whether to `oguri room join` or read the thread.
 */
export function surroundings(ctx: StatusContext): Surroundings {
  const seen = readJsonMeta<Record<string, string>>(ctx.state, SEEN_ROOMS_KEY, {});
  const subscribed = new Set(ctx.config.subscriptions);
  return {
    rooms: Object.keys(seen)
      .filter((roomId) => !subscribed.has(roomId))
      .sort(),
    threads: readJsonMeta<StoredThreadStart[]>(ctx.state, STARTED_THREADS_KEY, []).filter((entry) =>
      subscribed.has(entry.room),
    ),
  };
}

export async function status(ctx: StatusContext): Promise<NetworkStatus> {
  // One agenda pass serves both: the counts summarise what is owed, and the
  // in-flight threads are what make the pending messages classifiable.
  const agenda = await ctx.agenda({ limit: 0 });
  // Local, cache-only: co-located peers come from cards already on disk, so
  // this adds no round trip to the cheapest call in the surface.
  const peers = await ctx.peers().catch(() => []);
  return {
    networkId: ctx.networkId,
    remote: ctx.config.remote,
    agentId: ctx.identity.id,
    machine: {
      id: ctx.identity.machine.id,
      label: ctx.identity.machine.label,
      peers: peers.length,
      livePeers: peers.filter((peer) => peer.status === "live").length,
      room: machineRoomId(ctx.identity.machine.id),
    },
    subscriptions: [...ctx.config.subscriptions],
    pending: ctx.state.pendingCount(),
    pendingHuman: ctx.state.listInbox({ needs: "human" }).length,
    queued: (await ctx.outbox()).reduce((sum, r) => sum + r.ahead, 0),
    lastSyncAt: ctx.state.getMeta("lastSyncAt"),
    heads: Object.fromEntries(ctx.state.allHeads()),
    // Counts only: status is a summary, and the agenda itself is one call away.
    tasks: agenda.counts,
    surroundings: surroundings(ctx),
    attention: classifyAttention(ctx.state.listInbox({}), new Set(agenda.inFlightThreads)),
    health: ctx.health(),
  };
}
