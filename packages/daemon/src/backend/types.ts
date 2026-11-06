import type { OguriConfig } from "@oguri/core";

import type { Method } from "../protocol.ts";
import type { RunScope } from "./run-scope.ts";

/**
 * How the MCP server reaches oguri.
 *
 * Prefers the daemon, for two reasons that matter:
 *  - **presence becomes accurate** — an MCP server's lifetime IS an agent
 *    session's lifetime, so declaring the connection tells the network when
 *    this agent is genuinely live;
 *  - **inbox state gets a single writer**, instead of the daemon and this
 *    process both marking items processed.
 *
 * Falls back to direct mode so an editor without a running daemon still works
 * (ADR 0005) — at the cost of nothing accumulating between sessions.
 */
export interface Backend {
  readonly mode: "daemon" | "direct";
  /** Present when this process was started for a worker's run (ADR 0036). */
  readonly runScope?: RunScope;
  /**
   * `network` overrides which network this ONE call is about.
   *
   * A session binds to a network when it opens, which is right for the common
   * case and wrong for the one that made people restart editors: an agent whose
   * work spans two transport repos had no way to look at the second without
   * reopening its MCP server against a different default. The binding stays the
   * default; this makes it a per-call decision, so switching costs a parameter
   * rather than a session.
   */
  call<T = unknown>(method: Method, params?: Record<string, unknown>, network?: string): Promise<T>;
  /** Every network configured on this machine, current one first. */
  networks(): Promise<NetworkSummary[]>;
  close(): Promise<void>;
}

/** One configured network, as the surfaces list it. */
export interface NetworkSummary {
  id: string;
  remote: string;
  subscriptions: string[];
  /** True for the network a command with no `--network` resolves to. */
  current: boolean;
}

export function summariseNetworks(config: OguriConfig, currentId: string): NetworkSummary[] {
  return Object.values(config.networks)
    .map((net) => ({
      id: net.id,
      remote: net.remote,
      subscriptions: [...net.subscriptions],
      current: net.id === currentId,
    }))
    .sort((a, b) => (a.current === b.current ? a.id.localeCompare(b.id) : a.current ? -1 : 1));
}
