/**
 * What happens when a sync delivers: the inbox is staged on disk, and anything
 * that deserves a human's attention raises a notification.
 */

import { describeError, type Network, type SyncReport } from "@oguri/core";
import type { Message } from "@oguri/protocol";

import { shouldNotify, type Notifier } from "../notify.ts";
import type { PushDispatcher } from "../push.ts";

/** What delivery needs from the daemon. */
export interface DeliveryContext {
  readonly notifier: Notifier;
  /** Phone and chat channels from the local policy (ADR 0028). */
  readonly push: PushDispatcher;
  agentNearby(): boolean;
  log(message: string): void;
}

/** Stage the inbox on disk and decide what deserves a human's attention. */
export async function stageDelivered(
  daemon: DeliveryContext,
  networkId: string,
  network: Network,
  report: SyncReport,
): Promise<void> {
  if (report.delivered > 0) {
    daemon.log(`[${networkId}] delivered ${String(report.delivered)} message(s)`);
    await network.writeInboxFiles().catch((error: unknown) => {
      daemon.log(`inbox render failed: ${describeError(error)}`);
    });
  }
  for (const anomaly of report.anomalies) {
    // A modified or deleted message violates the append-only invariant, so it
    // is surfaced rather than quietly tolerated (ADR 0004).
    daemon.log(`[${networkId}] PROTOCOL ANOMALY ${anomaly.status} ${anomaly.path}`);
  }

  // Push channels apply their own rules to every delivery, independent of the
  // desktop decision below: a person away from the machine wants to hear about
  // a finished task even while an agent is at the keyboard draining the inbox.
  daemon.push.deliver(
    networkId,
    { agentId: network.identity.id, machineId: network.identity.machine.id },
    report.deliveredMessages,
  );

  const notable = report.deliveredMessages.filter((message) =>
    shouldNotify({
      needs: message.header.needs,
      priority: message.header.priority,
      directlyMentioned: message.header.mentions.includes(network.identity.id),
      // The question here is "is an agent around to drain this", not "did one
      // declare a session" — a CLI-driven agent answers just as well.
      sessionLive: daemon.agentNearby(),
    }),
  );
  if (notable.length === 0) return;

  const urgent = notable.some(
    (m) => m.header.needs === "human" || m.header.priority === "blocking",
  );
  await daemon.notifier
    .notify({
      title: summariseTitle(notable),
      body: summariseBody(notable),
      urgent,
    })
    .catch((error: unknown) => daemon.log(`notify failed: ${describeError(error)}`));
}

function summariseTitle(messages: readonly Message[]): string {
  if (messages.length === 1) {
    const only = messages[0] as Message;
    return only.header.needs === "human"
      ? `${only.header.from} needs a decision`
      : `${only.header.from} in #${only.header.room}`;
  }
  const rooms = new Set(messages.map((m) => m.header.room));
  return `${String(messages.length)} messages in ${[...rooms].map((r) => `#${r}`).join(", ")}`;
}

function summariseBody(messages: readonly Message[]): string {
  const first = messages[0] as Message;
  const line = first.body.trim().split("\n")[0] ?? "";
  return messages.length === 1 ? line : `${line} (+${String(messages.length - 1)} more)`;
}
