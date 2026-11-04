import {
  Layout,
  Network,
  loadConfig,
  resolveNetwork,
  saveConfig,
  type AgentRuntimeEnvironment,
  type OguriConfig,
  type NetworkConfig,
} from "@oguri/core";
import { stat } from "node:fs/promises";

import { isDaemonOnlyMethod, type Method } from "../protocol.ts";
import { summariseNetworks, type Backend, type NetworkSummary } from "./types.ts";
import * as direct from "./direct-dispatch.ts";
import type { DirectCallContext } from "./direct-dispatch.ts";

/**
 * How long a direct-mode answer may be, before the next read pulls again.
 *
 * Roughly the daemon's hot poll: fresh enough that an agent watching a
 * conversation is not answered from a view it has already outrun, loose enough
 * that a burst of calls in one turn is one `ls-remote` rather than ten.
 */
const DIRECT_FRESHNESS_MS = 10_000;

export class DirectBackend implements Backend {
  readonly mode = "direct" as const;
  private readonly layout: Layout;
  private config: OguriConfig;
  private netConfig: NetworkConfig;
  private network: Network;
  /** Which network was asked for, so a reload re-resolves the same one. */
  private readonly requested: string | undefined;
  /** Config mtime this backend was built from. See `refreshConfig`. */
  private configMtimeMs: number;
  /** When this backend last pulled, and the pull in flight. See `ensureFresh`. */
  private pulledAt = 0;
  private pulling: Promise<void> | null = null;
  /**
   * Other configured networks, opened on first use.
   *
   * The daemon has always had every network open at once; direct mode had one,
   * so the same `--network other` worked with a daemon and failed without.
   * Opened lazily because most sessions only ever touch one, and each open
   * costs a git handle and a SQLite connection.
   */
  private readonly others = new Map<
    string,
    { network: Network; pulledAt: number; pulling: Promise<void> | null }
  >();

  constructor(
    layout: Layout,
    config: OguriConfig,
    netConfig: NetworkConfig,
    options: { requested?: string; mtimeMs?: number } = {},
  ) {
    this.layout = layout;
    this.config = config;
    this.netConfig = netConfig;
    this.network = Network.open(layout, netConfig, config.agent);
    this.requested = options.requested;
    this.configMtimeMs = options.mtimeMs ?? 0;
  }

  /**
   * Pick up a config that changed under a long-lived process.
   *
   * An MCP server lives for the whole editor session, so binding config once
   * meant it could serve a network the config no longer contained: a reader saw
   * `network=oguri-test, pending=0` from MCP while the CLI saw a different
   * network with 39 unread. Both were "correct" about different worlds.
   *
   * Keyed on mtime so the common case is one `stat`, not a YAML parse.
   */
  private async refreshConfig(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.layout.configPath)).mtimeMs;
    } catch {
      return; // Config vanished mid-session; keep serving what we have.
    }
    if (mtimeMs === this.configMtimeMs) return;
    this.configMtimeMs = mtimeMs;

    const fresh = await loadConfig(this.layout.configPath);
    if (fresh === null) return;
    const resolved = resolveNetwork(fresh, this.requested);
    const rebind =
      resolved.id !== this.netConfig.id ||
      resolved.remote !== this.netConfig.remote ||
      fresh.agent.id !== this.config.agent.id;

    this.config = fresh;
    this.netConfig = resolved;
    if (rebind) {
      this.network.close();
      this.network = Network.open(this.layout, resolved, fresh.agent);
    } else {
      // Same network: adopt subscription changes without discarding the cache.
      this.network.config.subscriptions = [...resolved.subscriptions];
    }
  }

  /**
   * Pull before answering. Best effort, and at most once per window.
   *
   * With a daemon, every read is a cache hit by design, because the daemon is
   * the thing keeping the cache true. With no daemon there is no such thing: a
   * read answered from the cache is answering about a network nobody has looked
   * at. That is not merely stale — it cannot become right, so an agent polling
   * `oguri inbox` in a shell loop was told "inbox empty" indefinitely while the
   * messages sat on the remote, with nothing in the output to suggest the loop
   * was pointless. `oguri sync` fixed it, which is exactly the step the loop
   * existed to avoid needing.
   *
   * The window bounds what that costs. A one-shot command lives for a second,
   * so it pulls once however many calls it makes (the inbox reads health and
   * items); a direct-mode MCP server lives for the session, so it re-pulls as
   * its answers age instead of pulling once at startup and going quiet. Failure
   * counts as a pull, so an unreachable remote is not retried per call — the
   * read still answers from the cache, and `health` says why.
   */
  private async ensureFresh(): Promise<void> {
    if (this.pulling !== null) {
      await this.pulling;
      return;
    }
    if (Date.now() - this.pulledAt < DIRECT_FRESHNESS_MS) return;

    const pull = (async () => {
      try {
        const report = await this.network.sync();
        // Keep the filesystem surface (ADR 0009) in step when something landed.
        if (report.delivered > 0) await this.network.writeInboxFiles();
      } catch {
        // Recorded against the network's health, which every read carries.
      } finally {
        this.pulledAt = Date.now();
      }
    })();
    this.pulling = pull;
    try {
      await pull;
    } finally {
      this.pulling = null;
    }
  }

  /** Every configured network, so a caller can fan out without reading config. */
  async networks(): Promise<NetworkSummary[]> {
    await this.refreshConfig();
    return summariseNetworks(this.config, this.netConfig.id);
  }

  /**
   * The network one call is about: the bound one, or another by id.
   *
   * Another network gets its own freshness pull the first time it is touched,
   * for the reason the bound one does (`ensureFresh`): with no daemon nothing
   * else is pulling, and a cross-network read answered from a cache nobody
   * filled is the failure this whole path exists to prevent.
   */
  private async networkFor(id: string | undefined): Promise<Network> {
    if (id === undefined || id === this.netConfig.id) return this.network;
    let entry = this.others.get(id);
    if (entry === undefined) {
      const netConfig = resolveNetwork(this.config, id);
      entry = {
        network: Network.open(this.layout, netConfig, this.config.agent),
        pulledAt: 0,
        pulling: null,
      };
      this.others.set(id, entry);
    }
    // The pull is awaited, and shared. A cross-network read fires `health` and
    // `inbox` concurrently, so without joining the in-flight pull the second
    // call sees the network as already-freshened and reads the cache **before**
    // the first call's sync lands — an empty inbox on a network that has mail,
    // which is the exact failure this whole path exists to prevent.
    await this.freshen(entry);
    return entry.network;
  }

  private async freshen(entry: {
    network: Network;
    pulledAt: number;
    pulling: Promise<void> | null;
  }): Promise<void> {
    if (entry.pulling !== null) {
      await entry.pulling;
      return;
    }
    if (Date.now() - entry.pulledAt < DIRECT_FRESHNESS_MS) return;
    const pull = (async () => {
      try {
        const report = await entry.network.sync();
        if (report.delivered > 0) await entry.network.writeInboxFiles();
      } catch {
        // Recorded against that network's health, which its reads carry.
      } finally {
        entry.pulledAt = Date.now();
      }
    })();
    entry.pulling = pull;
    try {
      await pull;
    } finally {
      entry.pulling = null;
    }
  }

  async call<T>(
    method: Method,
    params: Record<string, unknown> = {},
    network?: string,
  ): Promise<T> {
    // Named before the work starts, so the caller is told the reason rather
    // than the symptom. Everything past this point is a method direct mode
    // owes an implementation for, and the switch in `callDirect` proves it does.
    if (isDaemonOnlyMethod(method)) {
      throw new Error(
        `method '${method}' needs a running daemon: direct mode has no daemon process or attached session to serve it. Start one with 'oguri daemon start'.`,
      );
    }

    await this.refreshConfig();
    // `sync` pulls on its own; everything else has to be told to.
    if (method !== "sync" && (network === undefined || network === this.netConfig.id)) {
      await this.ensureFresh();
    }
    const net = await this.networkFor(network);
    return (await direct.callDirect(this.directCallContext, method, params, net)) as T;
  }

  private get directCallContext(): DirectCallContext {
    return { persist: async () => await this.persist() };
  }

  private async persist(): Promise<void> {
    // Every open network, not just the bound one: `--network other room join`
    // changes `other`'s subscriptions, and saving only the bound network would
    // drop that change on the floor.
    this.config.networks[this.netConfig.id] = this.network.config;
    for (const { network } of this.others.values()) {
      this.config.networks[network.config.id] = network.config;
    }
    await saveConfig(this.layout.configPath, this.config);
  }

  async close(): Promise<void> {
    this.network.close();
    for (const { network } of this.others.values()) network.close();
    this.others.clear();
  }

  async publishConnectionProfile(environment: AgentRuntimeEnvironment): Promise<void> {
    await this.network.publishAgentProfile({}, environment);
  }
}
