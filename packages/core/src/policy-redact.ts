import { redactIntakePolicy } from "./intake-policy.ts";
import { redactNotificationPolicy } from "./notification-policy.ts";
import type { ResolvedPolicy } from "./policy.ts";

/**
 * The resolved policy with every credential replaced, safe to print, send over
 * the daemon socket, or hand to an agent.
 *
 * Push channel URLs and tokens (ADR 0028) and the intake app secret (ADR 0030)
 * live in this file, and the `policy` view of the MCP status tool reads it
 * back into a model's context. Every path that leaves the process goes
 * through here; only the daemon's own code reads the raw policy.
 */
export function redactPolicy(resolved: ResolvedPolicy): ResolvedPolicy {
  return {
    ...resolved,
    policy: {
      ...resolved.policy,
      notifications: redactNotificationPolicy(resolved.policy.notifications),
      intake: redactIntakePolicy(resolved.policy.intake),
    },
  };
}
