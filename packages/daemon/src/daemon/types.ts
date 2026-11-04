/** Shapes shared by the `Daemon` class and the modules its methods delegate to. */

import type { CadencePolicy, Layout, Network, NetworkConfig } from "@oguri/core";

import type { SyncLoop } from "../loop.ts";
import type { NotifierKind } from "../notify.ts";

export interface DaemonOptions {
  layout?: Layout;
  notifier?: NotifierKind;
  /** Suppress the sync loop; used by tests that drive `sync` explicitly. */
  autoSync?: boolean;
  /** Override the poll cadence — for tests, and for tuning a busy network. */
  cadence?: CadencePolicy;
  /**
   * How often to scan for work that has stopped moving. Defaults to
   * `STALL_SCAN_INTERVAL_MS`; tests set it to 0 so "reported once" is proven by
   * the reported-set rather than by the rate limiter.
   */
  stallScanIntervalMs?: number;
  /**
   * How long a session must stay attached before its arrival is published.
   *
   * A session that attaches and drops inside this window writes nothing, so an
   * editor reloading its MCP servers — or retrying one that fails to start —
   * cannot put a commit on `main` per attempt. There is no matching away grace:
   * departures are derived from the stamp going cold, not published.
   */
  presenceLiveGraceMs?: number;
  /** Timeout for each push send. Defaults to `PUSH_TIMEOUT_MS`; tests shorten it. */
  pushTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface NetworkContext {
  config: NetworkConfig;
  network: Network;
  loop: SyncLoop;
}

export interface SessionRegistration {
  isSession: () => boolean;
  network: () => string | null;
  markSession: (network: string | null) => void;
}
