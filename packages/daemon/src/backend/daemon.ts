import type { DaemonClient } from "../client.ts";
import type { Method } from "../protocol.ts";
import type { Backend, NetworkSummary } from "./types.ts";

export class DaemonBackend implements Backend {
  readonly mode = "daemon" as const;
  private readonly client: DaemonClient;
  /**
   * The network every request is pinned to.
   *
   * Load-bearing, and it was missing. The daemon serves every configured
   * network and picks its default when a request names none — so `--network x`
   * resolved `x` in direct mode and was **silently dropped** in daemon mode,
   * answering about the default network instead. A watcher armed on one
   * conversation reported another one quiet, which is indistinguishable from
   * nobody talking. Undefined still means "the daemon's default", which is what
   * a command with no `--network` asks for.
   */
  private readonly network: string | undefined;

  constructor(client: DaemonClient, network?: string) {
    this.client = client;
    this.network = network;
  }

  async call<T>(
    method: Method,
    params: Record<string, unknown> = {},
    network?: string,
  ): Promise<T> {
    return await this.client.request<T>(method, params, network ?? this.network);
  }

  async networks(): Promise<NetworkSummary[]> {
    return await this.client.request<NetworkSummary[]>("networks", {}, this.network);
  }

  async close(): Promise<void> {
    // Marks this agent away; the daemon publishes the transition.
    await this.client.request("sessionClose").catch(() => undefined);
    this.client.close();
  }
}
