/** The one signal not triggered by a message arriving: work that has stopped moving. */

import { describeError, type AgendaEntry, type Network } from "@oguri/core";

import type { Notifier } from "../notify.ts";

/** What the stalled-work scan needs from the daemon. */
export interface StalledContext {
  readonly notifier: Notifier;
  /** Per-network clock for the stalled-work scan. */
  readonly lastStallScanAt: Map<string, number>;
  readonly stallScanIntervalMs: number | undefined;
  log(message: string): void;
}

/**
 * Surface long-running work that has stopped moving.
 *
 * Every other signal in oguri is triggered by a message arriving. Silence is
 * the one that is not: a task whose owner simply stopped produces no event,
 * so a deadline could pass with nobody told — which made `stale_after`
 * decorative. This is the timer that makes it mean something.
 *
 * Local only. The daemon never writes to the shared log on the agent's
 * behalf: each peer runs one of these, so a task nagging from every machine
 * would put N copies of the same complaint in a permanent team-wide record.
 */
export async function escalateStalledWork(
  daemon: StalledContext,
  networkId: string,
  network: Network,
): Promise<void> {
  const last = daemon.lastStallScanAt.get(networkId) ?? 0;
  // A deadline is a wall-clock event, so this cannot ride on traffic; it is
  // rate-limited instead, because re-reading every subscribed room is not
  // free and the shortest useful threshold is still minutes.
  const interval = daemon.stallScanIntervalMs ?? STALL_SCAN_INTERVAL_MS;
  if (Date.now() - last < interval) return;
  daemon.lastStallScanAt.set(networkId, Date.now());

  const agenda = await network.agenda({ includeUnclaimed: false });
  const stalled = agenda.entries.filter((entry) => entry.needsAttention);
  // Keyed by health, not by id alone, so blocked → stuck is a new fact and a
  // task that recovers and stalls again is reported again.
  const current = stalled.map((entry) => `${entry.status.task.id}:${entry.status.health}`);
  const announced = new Set(decodeAnnounced(network.state.getMeta(STALLED_META_KEY)));
  network.state.setMeta(STALLED_META_KEY, JSON.stringify(current));

  const fresh = stalled.filter(
    (entry) => !announced.has(`${entry.status.task.id}:${entry.status.health}`),
  );
  if (fresh.length === 0) return;

  daemon.log(`[${networkId}] ${String(fresh.length)} task(s) need attention`);
  await daemon.notifier
    .notify({
      title:
        fresh.length === 1
          ? `task ${(fresh[0] as AgendaEntry).status.health}`
          : `${String(fresh.length)} tasks need attention`,
      body: fresh.map(describeStalledTask).join("; "),
    })
    .catch((error: unknown) => daemon.log(`notify failed: ${describeError(error)}`));
}

/**
 * How often the daemon looks for work that has stopped moving.
 *
 * The scan re-reads every subscribed room, so it is deliberately coarse. The
 * shortest silence threshold the protocol allows is a minute, but the default
 * is a day — five-minute granularity is far finer than the signal it reports.
 */
const STALL_SCAN_INTERVAL_MS = 5 * 60_000;

/** Meta key holding the task/health pairs already reported, so each fires once. */
const STALLED_META_KEY = "notifiedStalledTasks";

/**
 * Decode the reported set defensively. A malformed or absent value means
 * "nothing reported yet", which re-notifies at worst — never silence.
 */
function decodeAnnounced(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function describeStalledTask(entry: AgendaEntry): string {
  const task = entry.status.task;
  return `${entry.status.health} · ${task.title} (#${entry.room})`;
}
