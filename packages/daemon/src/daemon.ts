import type { Server, Socket } from "node:net";
import { mkdir, stat, unlink } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Layout,
  loadConfig,
  loadLocalPolicy,
  describeError,
  type AgentRuntimeEnvironment,
  type Network,
  type OguriConfig,
  type SyncReport,
} from "@oguri/core";

import { createNotifier, type Notifier } from "./notify.ts";
import { PushDispatcher } from "./push.ts";
import type { IpcRequest, Method } from "./protocol.ts";
import * as delivery from "./daemon/delivery.ts";
import type { DeliveryContext } from "./daemon/delivery.ts";
import * as dispatching from "./daemon/dispatch.ts";
import type { DispatchContext } from "./daemon/dispatch.ts";
import * as ipc from "./daemon/ipc.ts";
import type { IpcContext } from "./daemon/ipc.ts";
import * as presence from "./daemon/presence.ts";
import type { PresenceContext } from "./daemon/presence.ts";
import * as stalled from "./daemon/stalled.ts";
import type { StalledContext } from "./daemon/stalled.ts";
import * as syncLoop from "./daemon/sync-loop.ts";
import type { SyncLoopContext } from "./daemon/sync-loop.ts";
import type { DaemonOptions, NetworkContext, SessionRegistration } from "./daemon/types.ts";

export type { DaemonOptions } from "./daemon/types.ts";

/**
 * How long after a one-shot command the daemon still expects an agent to be
 * driving it. Cadence only: nothing here is published.
 */
const LOCAL_ACTIVITY_WINDOW_MS = 2 * 60_000;

/** Floor on how often one-shot commands may force a poll. See `noteLocalActivity`. */
const LOCAL_WAKE_INTERVAL_MS = 2_000;

/**
 * The one long-lived local process (ADR 0005).
 *
 * Owns continuous sync, the inbox, notifications and presence, and serves the
 * unix socket that the CLI and MCP server talk to. Its real job is the thing a
 * per-invocation CLI structurally cannot do: **accumulate an inbox while no
 * agent is running**, which is what makes the staged-delivery model work
 * (ADR 0006).
 *
 * The class owns state and lifecycle; each responsibility's method bodies live
 * in `./daemon/`, as functions over a context the class builds for them.
 */
export class Daemon {
  readonly layout: Layout;
  private readonly options: DaemonOptions;
  private readonly notifier: Notifier;
  /** Phone and chat pushes (ADR 0028). Channels are re-read from policy per delivery. */
  readonly push: PushDispatcher;
  private readonly networks = new Map<string, NetworkContext>();
  /** Attached session socket -> the one network selected by its desktop project. */
  private readonly sessions = new Map<Socket, string>();
  private server: Server | null = null;
  private config: OguriConfig | null = null;
  private stopping = false;
  /** Networks with a seal in flight. Per network, so one slow seal never blocks another. */
  private readonly sealing = new Set<string>();
  private nextConnectionId = 1;
  private presenceTimer: NodeJS.Timeout | null = null;
  /** When a one-shot command last talked to us. Cadence only — never presence. */
  private lastLocalRequestAt = 0;
  /** Config mtime this daemon's network set was built from. See `refreshConfig`. */
  private configMtimeMs = 0;
  /** Per-network clock for the stalled-work scan. See `escalateStalledWork`. */
  private readonly lastStallScanAt = new Map<string, number>();

  constructor(options: DaemonOptions = {}) {
    this.options = options;
    this.layout = options.layout ?? new Layout();
    this.notifier = createNotifier(
      options.notifier ?? "os",
      join(this.layout.inboxDir, "NOTICE.md"),
    );
    this.push = new PushDispatcher({
      loadChannels: async () => (await loadLocalPolicy(this.layout)).policy.notifications.channels,
      log: (message) => this.log(message),
      ...(options.pushTimeoutMs === undefined ? {} : { timeoutMs: options.pushTimeoutMs }),
    });
  }

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.options.log?.(line);
    void appendFile(join(this.layout.logsDir, "daemon.log"), `${line}\n`, "utf8").catch(
      () => undefined,
    );
  }

  /**
   * True while a declared agent session is attached.
   *
   * This — and only this — decides what presence publishes, because every
   * transition is a commit and a push on `main`. A session is a process whose
   * lifetime IS the session's (an MCP server, `oguri watch`); a one-shot
   * command that runs for a second is not one, and counting it as one wrote
   * `live` then `away` per invocation, per network.
   */
  get sessionLive(): boolean {
    return this.sessions.size > 0;
  }

  private sessionCount(networkId: string): number {
    let count = 0;
    for (const selected of this.sessions.values()) if (selected === networkId) count++;
    return count;
  }

  /**
   * True while an agent is *around*: attached, or driving oguri from the CLI
   * within the last few minutes.
   *
   * Local signal only — it feeds the sync cadence, never the published card.
   * An agent working through one-shot commands wants a hot cadence just as much
   * as an attached one, but it has announced nothing to the network, and
   * inventing a presence transition on its behalf is what made `main` chatter.
   */
  get agentNearby(): boolean {
    return this.sessionLive || Date.now() - this.lastLocalRequestAt < LOCAL_ACTIVITY_WINDOW_MS;
  }

  /**
   * Note that a one-shot command is talking to us, and pull for it.
   *
   * An agent driving oguri from a shell is asking about the network, not about
   * this machine's cache, so its command should not be answered from a view
   * that is a whole poll interval old. Rate-limited because the same agent may
   * poll in a loop, and an `ls-remote` per read is pressure the adaptive
   * cadence exists to avoid. Still nothing published: this is local only.
   */
  private noteLocalActivity(): void {
    const now = Date.now();
    const due = now - this.lastLocalRequestAt >= LOCAL_WAKE_INTERVAL_MS;
    this.lastLocalRequestAt = now;
    if (due) for (const ctx of this.networks.values()) ctx.loop.wake("agent at the keyboard");
  }

  get socketPath(): string {
    return this.layout.socketPath;
  }

  async start(): Promise<void> {
    await mkdir(this.layout.logsDir, { recursive: true });
    await this.reload();
    // No presence write here. A `live` card left behind by a crash needs no
    // repair — its stamp has stopped moving, which is exactly how a reader
    // learns the agent is gone — and writing one would put a commit on `main`
    // every time a daemon started.
    await this.listen();
    if (this.options.autoSync !== false) {
      for (const ctx of this.networks.values()) ctx.loop.start();
    }
    this.log(`daemon ready on ${this.socketPath} (${String(this.networks.size)} network(s))`);
  }

  /** Load config and open every configured network. */
  private async reload(): Promise<void> {
    const config = await loadConfig(this.layout.configPath);
    if (config === null)
      throw new Error(`no config at ${this.layout.configPath} — run: oguri init`);
    this.config = config;

    syncLoop.openNetworks(this.syncLoopContext, config);
  }

  /**
   * Pick up networks added since this daemon started.
   *
   * The daemon read the config once, at startup, so `oguri init --network x`
   * in one terminal left every command against `x` in another terminal talking
   * to a daemon that had never heard of it. The config is the shared truth
   * between the two processes, and it changes under a long-lived one; keyed on
   * mtime so the common case is a `stat`, not a YAML parse and a reopen.
   */
  private async refreshConfig(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.layout.configPath)).mtimeMs;
    } catch {
      return; // Config vanished; keep serving what is already open.
    }
    if (mtimeMs === this.configMtimeMs) return;
    this.configMtimeMs = mtimeMs;
    await this.reload().catch((error: unknown) => {
      this.log(`config reload failed: ${describeError(error)}`);
    });
  }

  // ---------------------------------------------------------------- sync loop

  private get syncLoopContext(): SyncLoopContext {
    return {
      layout: this.layout,
      networks: this.networks,
      autoSync: this.options.autoSync,
      cadence: this.options.cadence,
      listening: () => this.server !== null,
      agentNearby: () => this.agentNearby,
      isSealing: (networkId) => this.sealing.has(networkId),
      setSealing: (networkId, sealing) => {
        if (sealing) this.sealing.add(networkId);
        else this.sealing.delete(networkId);
      },
      onReport: async (networkId, network, report) =>
        await this.onReport(networkId, network, report),
      maybeSeal: async (networkId, network) => await this.maybeSeal(networkId, network),
      stageDelivered: async (networkId, network, report) =>
        await this.stageDelivered(networkId, network, report),
      refreshPresenceWhileAwaited: async (network) =>
        await this.refreshPresenceWhileAwaited(network),
      escalateStalledWork: async (networkId, network) =>
        await this.escalateStalledWork(networkId, network),
      log: (message) => this.log(message),
    };
  }

  /** Stage what a sync delivered, then look at what did not arrive. */
  private async onReport(networkId: string, network: Network, report: SyncReport): Promise<void> {
    await syncLoop.onReport(this.syncLoopContext, networkId, network, report);
  }

  /** Compact any room that has outgrown its retention window. */
  private async maybeSeal(networkId: string, network: Network): Promise<void> {
    await syncLoop.maybeSeal(this.syncLoopContext, networkId, network);
  }

  // ----------------------------------------------------------------- delivery

  private get deliveryContext(): DeliveryContext {
    return {
      notifier: this.notifier,
      push: this.push,
      agentNearby: () => this.agentNearby,
      log: (message) => this.log(message),
    };
  }

  /** Stage the inbox on disk and decide what deserves a human's attention. */
  private async stageDelivered(
    networkId: string,
    network: Network,
    report: SyncReport,
  ): Promise<void> {
    await delivery.stageDelivered(this.deliveryContext, networkId, network, report);
  }

  // ------------------------------------------------------------- stalled work

  private get stalledContext(): StalledContext {
    return {
      notifier: this.notifier,
      lastStallScanAt: this.lastStallScanAt,
      stallScanIntervalMs: this.options.stallScanIntervalMs,
      log: (message) => this.log(message),
    };
  }

  /** Surface long-running work that has stopped moving. */
  private async escalateStalledWork(networkId: string, network: Network): Promise<void> {
    await stalled.escalateStalledWork(this.stalledContext, networkId, network);
  }

  // ----------------------------------------------------------------- presence

  private get presenceContext(): PresenceContext {
    return {
      networks: this.networks,
      sessions: this.sessions,
      presenceLiveGraceMs: this.options.presenceLiveGraceMs,
      sessionLive: () => this.sessionLive,
      stopping: () => this.stopping,
      presenceTimer: () => this.presenceTimer,
      setPresenceTimer: (timer) => {
        this.presenceTimer = timer;
      },
      publishPresence: async () => await this.publishPresence(),
      log: (message) => this.log(message),
    };
  }

  /** Keep this agent readable as live while somebody is waiting on it. */
  private async refreshPresenceWhileAwaited(network: Network): Promise<void> {
    await presence.refreshPresenceWhileAwaited(this.presenceContext, network);
  }

  /** Record that a session is attached on the network selected by its project. */
  private async publishPresence(): Promise<void> {
    await presence.publishPresence(this.presenceContext);
  }

  /** Refresh allowlisted runtime facts only on the project-selected network. */
  private async publishProfile(
    networkId: string,
    environment: AgentRuntimeEnvironment,
  ): Promise<void> {
    await presence.publishProfile(this.presenceContext, networkId, environment);
  }

  /** React to a session attaching or dropping. */
  private async onSessionChange(): Promise<void> {
    await presence.onSessionChange(this.presenceContext);
  }

  // ---------------------------------------------------------------- ipc

  private get ipcContext(): IpcContext {
    return {
      layout: this.layout,
      socketPath: this.socketPath,
      sessions: this.sessions,
      setServer: (server) => {
        this.server = server;
      },
      nextConnectionId: () => this.nextConnectionId++,
      noteLocalActivity: () => {
        this.noteLocalActivity();
      },
      refreshConfig: async () => await this.refreshConfig(),
      onSessionChange: async () => await this.onSessionChange(),
      dispatch: async (method, request, session) => await this.dispatch(method, request, session),
      log: (message) => this.log(message),
    };
  }

  private async listen(): Promise<void> {
    await ipc.listen(this.ipcContext);
  }

  private resolve(networkId?: string): NetworkContext {
    if (this.networks.size === 0) throw new Error("no networks configured — run: oguri init");
    if (networkId !== undefined) {
      const ctx = this.networks.get(networkId);
      if (ctx === undefined) throw new Error(`unknown network ${networkId}`);
      return ctx;
    }
    const preferred = this.config?.defaultNetwork;
    if (preferred !== undefined && preferred !== null) {
      const ctx = this.networks.get(preferred);
      if (ctx !== undefined) return ctx;
    }
    if (this.networks.size > 1) {
      throw new Error(
        `several networks configured; specify one of: ${[...this.networks.keys()].join(", ")}`,
      );
    }
    return [...this.networks.values()][0] as NetworkContext;
  }

  private get dispatchContext(): DispatchContext {
    return {
      config: () => this.config,
      networks: this.networks,
      socketPath: this.socketPath,
      sessionLive: () => this.sessionLive,
      sessionCount: (networkId) => this.sessionCount(networkId),
      resolve: (networkId) => this.resolve(networkId),
      onReport: async (networkId, network, report) =>
        await this.onReport(networkId, network, report),
      onSessionChange: async () => await this.onSessionChange(),
      publishProfile: async (networkId, environment) =>
        await this.publishProfile(networkId, environment),
      persistSubscriptions: async () => await this.persistSubscriptions(),
      stop: async () => await this.stop(),
      log: (message) => this.log(message),
    };
  }

  private async dispatch(
    method: Method,
    request: IpcRequest,
    session: SessionRegistration,
  ): Promise<unknown> {
    return await dispatching.dispatch(this.dispatchContext, method, request, session);
  }

  /** Persist subscription changes made through the socket back to config.yaml. */
  private async persistSubscriptions(): Promise<void> {
    if (this.config === null) return;
    for (const ctx of this.networks.values()) {
      this.config.networks[ctx.config.id] = ctx.network.config;
    }
    const { saveConfig } = await import("@oguri/core");
    await saveConfig(this.layout.configPath, this.config);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log("shutting down");

    for (const ctx of this.networks.values()) ctx.loop.stop();

    // Nothing to publish on the way out. A daemon that stops — cleanly, or by
    // being killed, which it cannot distinguish for the peer's benefit — stops
    // refreshing its stamp, and that is the departure. Any pending arrival is
    // dropped rather than raced to the remote.
    if (this.presenceTimer !== null) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    const open = [...this.sessions.keys()];
    this.sessions.clear();
    for (const socket of open) socket.destroy();

    if (this.server !== null) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    await unlink(this.socketPath).catch(() => undefined);
    for (const ctx of this.networks.values()) ctx.network.close();
    this.networks.clear();
  }
}
