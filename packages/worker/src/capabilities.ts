/**
 * Make this worker's capabilities visible to planners.
 *
 * A planner chooses where work goes by reading profiles (ADR 0019). A worker
 * whose `worker.capabilities` say `gpu` but whose profile does not would claim
 * capability work no planner knew to send it. So at start the worker adds the
 * missing names to its own profile. It adds, never removes: the profile also
 * carries what a person wrote there, and that is theirs.
 */

import type { AgentProfile } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

/** A profile list holds at most this many entries (see `agent/profile.ts`). */
const PROFILE_LIST_LIMIT = 20;

export interface PublishedCapabilities {
  /** Names added to the profile; empty when it already had them all. */
  added: string[];
}

export async function publishCapabilities(
  backend: Backend,
  capabilities: readonly string[],
): Promise<PublishedCapabilities> {
  if (capabilities.length === 0) return { added: [] };
  const profile = await backend.call<AgentProfile | null>("profileGet", {});
  const existing = profile?.capabilities ?? [];
  const missing = capabilities.filter((name) => !existing.includes(name));
  if (missing.length === 0) return { added: [] };
  const next = [...existing, ...missing];
  if (next.length > PROFILE_LIST_LIMIT) {
    throw new Error(
      `the profile would list ${String(next.length)} capabilities, more than ${String(PROFILE_LIST_LIMIT)}; remove some with oguri profile update`,
    );
  }
  // Only `capabilities` is sent, so every other field keeps what it had.
  await backend.call("profileUpdate", { input: { capabilities: next } });
  return { added: missing };
}
