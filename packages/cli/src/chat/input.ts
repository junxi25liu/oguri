/**
 * The input and pure guards shared by the terminal and web chat surfaces.
 *
 * An HTTP caller names only a target, a thread, and a body. The target grammar
 * is the same one routing uses; a thread is a ULID, never a path or a query.
 */

import type { MachineRow } from "@oguri/core";
import { isAgentId, isMachineToken, machineFromToken } from "@oguri/protocol";

import { assertChatBody, isThreadId, parseChatTarget, type ChatTarget } from "./service.ts";

/** Every target a person may choose, including an agent id for each machine. */
export function chatTargets(machines: readonly MachineRow[]): ChatTarget[] {
  const targets: ChatTarget[] = [parseChatTarget("big")];
  const seen = new Set(["big"]);
  for (const machine of machines) {
    if (machine.id === null) continue;
    const machineValue = `machine:${machine.id}`;
    if (!seen.has(machineValue)) {
      seen.add(machineValue);
      targets.push(parseChatTarget(machineValue));
    }
    for (const agent of machine.agents) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      targets.push({
        kind: "small",
        value: agent.id,
        mention: agent.id,
        label: `Small · ${agent.id} · ${machine.label ?? machine.id}`,
      });
    }
  }
  return targets;
}

/** Reject a `target` that cannot be delivered, before anything is written. */
export function assertChatTarget(value: string | null | undefined): ChatTarget {
  const target = parseChatTarget(value);
  if (target.kind === "small" && !isAgentId(target.value) && !isMachineToken(target.value)) {
    throw new Error("target must be big, an agent id, or machine:<id>");
  }
  return target;
}

/** Machine tokens are resolved to one agent by the service at send time. */
export function machineOf(value: string): string | null {
  return machineFromToken(value);
}

export interface ChatRequest {
  target: ChatTarget;
  body: string;
  thread?: string;
}

/** Validate the whole JSON shape a chat write may carry. */
export function assertChatRequest(value: unknown): ChatRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("a JSON object is required");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set(["target", "body", "thread"]);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected field '${key}'`);
  }
  const target = assertChatTarget(
    typeof row["target"] === "string" || row["target"] === undefined ? row["target"] : "",
  );
  const body = assertChatBody(typeof row["body"] === "string" ? row["body"] : "");
  const thread = row["thread"];
  // A web client may send an explicit null while it has no thread yet.
  if (thread !== undefined && thread !== null && !isThreadId(thread as string)) {
    throw new TypeError("thread must be a message id");
  }
  return {
    target,
    body,
    ...(typeof thread === "string" ? { thread } : {}),
  };
}

/** An optional `thread=` query value is never trusted as HTML. */
export function chatThread(value: string | null | undefined): string | undefined {
  return isThreadId(value) ? value : undefined;
}

export { isThreadId };
