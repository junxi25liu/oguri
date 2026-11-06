/**
 * Moving a failed task one tier up (ADR 0034).
 *
 * Pure, like `retry.ts`: given the policy and the run that failed, it decides
 * whether the next try runs one tier higher, and writes the task definition
 * that says so. The worker publishes that definition as a `refined` event
 * while it still holds the task, then releases it, so the next claimant —
 * this machine after its backoff, or any other — reads the new tier from the
 * task itself and checks it against its own policy.
 */

import {
  allowListGate,
  escalationFor,
  renderTaskHeader,
  type RunnerGate,
  type WorkerPolicy,
} from "@oguri/core";

import type { Candidate } from "./select.ts";

export type EscalationStep =
  | {
      /** The whole new definition: header lines, then the task's own text. */
      definition: string;
      tier: string;
      runner: string;
      effort?: string;
      /** How many times the task has now moved up. */
      step: number;
      /** One sentence for the release body. */
      note: string;
    }
  | { stay: string };

/**
 * The next tier for a candidate whose run failed and is about to be released.
 *
 * A task that never asked for a tier is left alone, quietly: there is nothing
 * to say about a ladder it is not on.
 */
export function escalateCandidate(
  policy: Pick<WorkerPolicy, "runners" | "tiers" | "escalation">,
  candidate: Pick<Candidate, "tier" | "escalated" | "runner" | "prompt">,
  gate: RunnerGate = allowListGate,
): EscalationStep {
  const escalated = candidate.escalated ?? 0;
  const next = escalationFor(
    policy,
    { ...(candidate.tier === undefined ? {} : { tier: candidate.tier }), escalated },
    gate,
  );
  if ("stay" in next) return next;
  const from = candidate.tier as string;
  const reason = `moved up from tier ${from} (runner ${candidate.runner}) after a failed run`;
  return {
    definition: `${renderTaskHeader({
      runner: next.runner,
      ...(next.effort === undefined ? {} : { effort: next.effort }),
      tier: next.tier,
      reason,
      escalated: next.step,
    })}${candidate.prompt}`,
    tier: next.tier,
    runner: next.runner,
    ...(next.effort === undefined ? {} : { effort: next.effort }),
    step: next.step,
    note: `The next try runs one tier up: tier ${next.tier}, runner ${next.runner} (step ${String(next.step)} of at most ${String(policy.escalation.maxSteps)}).`,
  };
}
