/**
 * The per-network sync loop, and what the daemon does with each sync it runs.
 */

import {
  Network,
  describeError,
  type CadencePolicy,
  type Layout,
  type OguriConfig,
  type SyncReport,
} from "@oguri/core";

import { SyncLoop } from "../loop.ts";
import type { NetworkContext } from "./types.ts";

/** What the sync loop needs from the daemon. */
export interface SyncLoopContext {
  readonly layout: Layout;
  readonly networks: Map<string, NetworkContext>;
  readonly autoSync: boolean | undefined;
  readonly cadence: CadencePolicy | undefined;
  /** True once the socket is up; see the end of `openNetworks`. */
  listening(): boolean;
  agentNearby(): boolean;
  isSealing(networkId: string): boolean;
  setSealing(networkId: string, sealing: boolean): void;
  onReport(networkId: string, network: Network, report: SyncReport): Promise<void>;
  maybeSeal(networkId: string, network: Network): Promise<void>;
  stageDelivered(networkId: string, network: Network, report: SyncReport): Promise<void>;
  refreshPresenceWhileAwaited(network: Network): Promise<void>;
  escalateStalledWork(networkId: string, network: Network): Promise<void>;
  log(message: string): void;
}

/** Open every configured network not already open, each with its own loop. */
export function openNetworks(daemon: SyncLoopContext, config: OguriConfig): void {
  for (const netConfig of Object.values(config.networks)) {
    if (daemon.networks.has(netConfig.id)) continue;
    const network = Network.open(daemon.layout, netConfig, config.agent);
    const loop = new SyncLoop({
      network,
      // Deliberately the broader signal: an agent working through one-shot
      // commands needs a fresh inbox as much as an attached one, and polling
      // costs an `ls-remote`, not a commit.
      sessionLive: () => daemon.agentNearby(),
      onReport: async (report) => {
        await daemon.onReport(netConfig.id, network, report);
        void daemon.maybeSeal(netConfig.id, network);
      },
      onError: (error) => daemon.log(`sync failed [${netConfig.id}]: ${describeError(error)}`),
      ...(daemon.cadence === undefined ? {} : { cadence: daemon.cadence }),
      log: (message) => daemon.log(`[${netConfig.id}] ${message}`),
    });
    daemon.networks.set(netConfig.id, { config: netConfig, network, loop });
    // A network added while the daemon was already up must start polling too,
    // or it is served but never delivered into.
    if (daemon.autoSync !== false && daemon.listening()) loop.start();
  }
}

/**
 * React to a completed sync: stage what arrived, then look at what did not.
 *
 * Both halves belong here rather than at the call site, because a sync
 * reaches this from two directions — the poll loop and an explicit `sync`
 * over IPC — and a signal that fires on only one of them is worse than none.
 */
export async function onReport(
  daemon: SyncLoopContext,
  networkId: string,
  network: Network,
  report: SyncReport,
): Promise<void> {
  await daemon.stageDelivered(networkId, network, report);
  await daemon.refreshPresenceWhileAwaited(network);
  await daemon
    .escalateStalledWork(networkId, network)
    .catch((error: unknown) => daemon.log(`stalled-work scan failed: ${describeError(error)}`));
}

/**
 * Compact any room that has outgrown its retention window.
 *
 * Deliberately NOT awaited by the sync loop: a seal pushes several times and
 * can take a while, and blocking the loop on it would stall delivery. The
 * per-network `sealing` guard keeps concurrent seals of one network from
 * piling up without holding back the others, and the git-CAS lock
 * (spec §11) keeps other machines out.
 */
export async function maybeSeal(
  daemon: SyncLoopContext,
  networkId: string,
  network: Network,
): Promise<void> {
  if (daemon.isSealing(networkId)) return;
  daemon.setSealing(networkId, true);
  try {
    const due = await network.roomsNeedingSeal();
    for (const decision of due) {
      daemon.log(`[${networkId}] sealing ${decision.roomId}: ${decision.reason}`);
      const result = await network.seal(decision.roomId);
      daemon.log(
        result.sealed > 0
          ? `[${networkId}] sealed ${String(result.sealed)} from ${decision.roomId} → ${String(result.digest)}`
          : `[${networkId}] seal of ${decision.roomId} skipped: ${String(result.skipped)}`,
      );
    }
  } catch (error) {
    // Retention falling behind degrades performance, never correctness — the
    // messages are still there. Never let it take the daemon down.
    daemon.log(`[${networkId}] seal failed: ${describeError(error)}`);
  } finally {
    daemon.setSealing(networkId, false);
  }
}
