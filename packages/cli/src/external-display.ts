/**
 * How the CLI shows where a message or task came from outside oguri (ADR 0030).
 *
 * A message relayed from a chat is written by the intake agent, so `from`
 * names that agent. The person who actually spoke is in `external`, and a
 * reader needs to see them, not the bridge. A task asked for in a chat carries
 * its `origin` and `mandate`; `task show` prints both, because they answer
 * "who asked for this, and why may it be done".
 */

import type { ExternalRef, MessageHeader, Task } from "@oguri/protocol";

/** `[feishu · Alice]`, or the actor id when the source gave no name. */
export function externalMark(external: ExternalRef): string {
  return `[${external.source} · ${external.actorName ?? external.actor}]`;
}

/** `relay:ack` and the like, or null when the message goes nowhere outside oguri. */
export function relayMark(header: Pick<MessageHeader, "relay">): string | null {
  return header.relay === undefined ? null : `relay:${header.relay}`;
}

/** The lines `task show` prints for a task's origin and mandate; empty when it has neither. */
export function originLines(task: Pick<Task, "origin" | "mandate">): string[] {
  const lines: string[] = [];
  const origin = task.origin;
  if (origin !== undefined) {
    lines.push(
      `origin   ${origin.source} · conversation ${origin.conversation} · requested by ${origin.requester}`,
    );
    if (origin.thread !== undefined) lines.push(`         thread ${origin.thread}`);
    if (origin.url !== undefined) lines.push(`         ${origin.url}`);
  }
  const mandate = task.mandate;
  if (mandate !== undefined) {
    lines.push(`mandate  ${mandate.strength} · via ${mandate.via} · policy ${mandate.policy}`);
  }
  return lines;
}
