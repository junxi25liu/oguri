/**
 * Presence: what this daemon publishes about whether its agent is around.
 *
 * Every transition is a commit and a push on `main`, so each write here is
 * gated on an attached session, and departures are never written at all.
 */

import { describeError, type AgentRuntimeEnvironment, type Network } from "@oguri/core";
import type { Socket } from "node:net";

import type { NetworkContext } from "./types.ts";

/** Long enough that a session which flickers never reaches the record branch. */
const PRESENCE_LIVE_GRACE_MS = 3_000;

/** What presence needs from the daemon. */
export interface PresenceContext {
  readonly networks: Map<string, NetworkContext>;
  /** Attached session socket -> the one network selected by its desktop project. */
  readonly sessions: Map<Socket, string>;
  readonly presenceLiveGraceMs: number | undefined;
  sessionLive(): boolean;
  stopping(): boolean;
  presenceTimer(): NodeJS.Timeout | null;
  setPresenceTimer(timer: NodeJS.Timeout | null): void;
  publishPresence(): Promise<void>;
  log(message: string): void;
}

/**
 * Keep this agent readable as live **while somebody is waiting on it**.
 *
 * Presence is derived from a stamp that only moves when a session attaches
 * (ADR 0022), which is honest but has one bad case, reported from real use:
 * an agent attached and working for an hour reads `away` to the peer who just
 * asked it something. The peer concludes nobody is there and stops waiting,
 * while the agent is mid-answer.
 *
 * A heartbeat would fix it and is exactly what ADR 0022 refuses: a beat per
 * agent per few minutes is a commit stream on `main` larger than the
 * conversation. So the refresh is **demand-driven** instead — it happens only
 * when a session is attached AND this agent has unanswered mail. Nobody
 * waiting costs nothing; somebody waiting costs at most one commit per live
 * window, because `publishAgentCard` writes only once the stamp has actually
 * aged out of it.
 */
export async function refreshPresenceWhileAwaited(
  daemon: PresenceContext,
  network: Network,
): Promise<void> {
  if (!daemon.sessionLive()) return;
  if (network.state.pendingCount() === 0) return;
  await network
    .publishAgentCard({ presence: "live" })
    .catch((error: unknown) => daemon.log(`presence refresh failed: ${describeError(error)}`));
}

/**
 * Record that a session is attached on the network selected by its project.
 *
 * The only presence write there is. Arrivals are the one thing silence cannot
 * express, so they are stamped on the card; departure needs no write at all,
 * because a reader derives it from the stamp going cold. Never a heartbeat:
 * a beat would generate more commits than the actual conversation does, and
 * `main` is meant to stay cold.
 */
export async function publishPresence(daemon: PresenceContext): Promise<void> {
  const liveNetworks = new Set(daemon.sessions.values());
  for (const networkId of liveNetworks) {
    const ctx = daemon.networks.get(networkId);
    if (ctx === undefined) continue;
    try {
      const published = await ctx.network.publishAgentCard({ presence: "live" });
      if (published) daemon.log(`[${ctx.config.id}] presence → live`);
    } catch (error) {
      daemon.log(`presence publish failed: ${describeError(error)}`);
    }
  }
}

/** Refresh allowlisted runtime facts only on the project-selected network. */
export async function publishProfile(
  daemon: PresenceContext,
  networkId: string,
  environment: AgentRuntimeEnvironment,
): Promise<void> {
  const ctx = daemon.networks.get(networkId);
  if (ctx === undefined) return;
  try {
    const published = await ctx.network.publishAgentProfile({}, environment);
    if (published) daemon.log(`[${ctx.config.id}] agent profile refreshed`);
  } catch (error) {
    daemon.log(`agent profile publish failed: ${describeError(error)}`);
  }
}

/**
 * React to a session attaching or dropping.
 *
 * A drop writes nothing: presence is derived from how old the card's stamp
 * is, so an agent going away IS an agent that stops writing. That removes the
 * write nobody was reliably around to make — and with it the live/away
 * flapping, since there is no bit left to flip.
 *
 * An arrival is published, but only once the daemon has settled on it: an
 * editor reloading its MCP servers, or retrying one that fails to start,
 * attaches and drops faster than the grace and so reaches `main` never.
 */
export async function onSessionChange(daemon: PresenceContext): Promise<void> {
  const pending = daemon.presenceTimer();
  if (pending !== null) {
    clearTimeout(pending);
    daemon.setPresenceTimer(null);
  }
  if (!daemon.sessionLive()) return;

  const liveNetworks = new Set(daemon.sessions.values());
  for (const networkId of liveNetworks) daemon.networks.get(networkId)?.loop.wake("session opened");
  if (daemon.stopping()) return;

  const timer = setTimeout(() => {
    daemon.setPresenceTimer(null);
    if (daemon.sessionLive()) void daemon.publishPresence();
  }, daemon.presenceLiveGraceMs ?? PRESENCE_LIVE_GRACE_MS);
  daemon.setPresenceTimer(timer);
  timer.unref();
}
