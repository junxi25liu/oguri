/**
 * Runner tiers: which runner a task gets, by how hard it is (ADR 0034).
 *
 * `worker.tiers` groups runners the owner already listed into rungs, cheapest
 * first. A superagent picks a rung for each task and writes it on the task's
 * header; the worker that claims the task checks the rung against its own
 * policy before it runs anything, and a failed run may climb one rung, a
 * bounded number of times.
 *
 * A tier never adds a command or an argument. It can only name entries of
 * `worker.runners`, and the effort it carries must already be on that
 * runner's `efforts` list. Everything here reads the machine-local policy;
 * the task header is a request, checked again where the task runs.
 *
 * This lives in core because the superagents write the header and the worker
 * reads it, and both must agree on what a tier resolves to.
 */

import type { WorkerPolicy, WorkerTier } from "./policy.ts";

/**
 * Whether a runner may be used here, and why not when it may not.
 *
 * Today the only rule is the allow-list: a runner is usable when it is an
 * entry of `worker.runners`. A grant check (which runners this machine's owner
 * has authorised for unattended use) plugs in here without changing a caller:
 * every tier decision goes through this one question.
 */
export type RunnerGate = (
  name: string,
  worker: Pick<WorkerPolicy, "runners">,
) => { ok: true } | { ok: false; reason: string };

/** The allow-list alone: the gate every caller gets unless it passes another. */
export const allowListGate: RunnerGate = (name, worker) =>
  Object.hasOwn(worker.runners, name)
    ? { ok: true }
    : {
        ok: false,
        reason: `runner '${name}' is not on worker.runners (${Object.keys(worker.runners).join(", ") || "none"})`,
      };

/**
 * Whether `name` may be used here: on the allow-list, and passing `gate`.
 *
 * The allow-list is always checked first, so a gate can only narrow what the
 * policy allows, never widen it.
 */
export function runnerAvailability(
  worker: Pick<WorkerPolicy, "runners">,
  name: string,
  gate: RunnerGate = allowListGate,
): { ok: true } | { ok: false; reason: string } {
  const listed = allowListGate(name, worker);
  if (!listed.ok) return listed;
  return gate === allowListGate ? listed : gate(name, worker);
}

export function findTier(
  worker: Pick<WorkerPolicy, "tiers">,
  name: string,
): WorkerTier | undefined {
  return worker.tiers.find((tier) => tier.name === name);
}

/** The tier a runner sits in, when it sits in one. */
export function tierOfRunner(
  worker: Pick<WorkerPolicy, "tiers">,
  runner: string,
): WorkerTier | undefined {
  return worker.tiers.find((tier) => tier.runners.includes(runner));
}

/** The next tier up, or undefined at the top. */
export function nextTier(
  worker: Pick<WorkerPolicy, "tiers">,
  name: string,
): WorkerTier | undefined {
  const index = worker.tiers.findIndex((tier) => tier.name === name);
  return index === -1 ? undefined : worker.tiers[index + 1];
}

/** What a tier request resolves to on this machine. */
export interface ResolvedTier {
  tier: string;
  runner: string;
  /** The effort to ask for: the request's, else the tier's. Checked again by the worker. */
  effort?: string;
}

/**
 * Resolve a tier request against this machine's policy, or say why it cannot be.
 *
 * - An unknown tier is refused, naming the tiers there are.
 * - A named runner must be in the tier and available; it is never swapped for
 *   another, because the requester chose it on purpose.
 * - With no runner named, the tier's first available runner is used, and when
 *   none is available every reason is given.
 */
export function resolveTier(
  worker: Pick<WorkerPolicy, "runners" | "tiers">,
  request: { tier: string; runner?: string; effort?: string },
  gate: RunnerGate = allowListGate,
): ResolvedTier | { error: string } {
  const tier = findTier(worker, request.tier);
  if (tier === undefined) {
    const known = worker.tiers.map((t) => t.name).join(", ");
    return {
      error:
        worker.tiers.length === 0
          ? `tier '${request.tier}' was asked for, but worker.tiers is not configured here`
          : `tier '${request.tier}' is not configured here (worker.tiers: ${known})`,
    };
  }
  const effort = request.effort ?? tier.effort;
  const withEffort = (runner: string): ResolvedTier => ({
    tier: tier.name,
    runner,
    ...(effort === undefined ? {} : { effort }),
  });
  if (request.runner !== undefined) {
    if (!tier.runners.includes(request.runner)) {
      return {
        error: `runner '${request.runner}' is not in tier '${tier.name}' (${tier.runners.join(", ")})`,
      };
    }
    const available = runnerAvailability(worker, request.runner, gate);
    if (!available.ok) {
      return {
        error: `runner '${request.runner}' of tier '${tier.name}' cannot run here: ${available.reason}`,
      };
    }
    return withEffort(request.runner);
  }
  const reasons: string[] = [];
  for (const runner of tier.runners) {
    const available = runnerAvailability(worker, runner, gate);
    if (available.ok) return withEffort(runner);
    reasons.push(available.reason);
  }
  return { error: `no runner of tier '${tier.name}' can run here: ${reasons.join("; ")}` };
}

/** Where a failed task goes next, or why it stays where it is. */
export type Escalation =
  { tier: string; runner: string; effort?: string; step: number } | { stay: string };

/**
 * One tier up for a task whose run failed and will be tried again.
 *
 * Only a task that asked for a tier climbs. A task that named its runner
 * without one was pinned on purpose — often because its owner asked for that
 * model — and moving it would override that choice.
 *
 * Bounded twice: by `worker.escalation.maxSteps` over the task's whole life
 * (`escalated` is how many times it already climbed), and by the top of the
 * ladder. The task's own `maxAttempts` bounds the tries themselves.
 */
export function escalationFor(
  worker: Pick<WorkerPolicy, "runners" | "tiers" | "escalation">,
  current: { tier?: string; escalated: number },
  gate: RunnerGate = allowListGate,
): Escalation {
  const max = worker.escalation.maxSteps;
  if (max === 0) return { stay: "worker.escalation is off" };
  const from = current.tier;
  if (from === undefined) {
    return { stay: "the task names its runner rather than a tier, so it is not moved" };
  }
  if (current.escalated >= max) {
    return {
      stay: `it has already moved up ${String(current.escalated)} tier(s), the limit of worker.escalation.maxSteps`,
    };
  }
  const next = nextTier(worker, from);
  if (next === undefined) return { stay: `'${from}' is the top tier` };
  const resolved = resolveTier(worker, { tier: next.name }, gate);
  if ("error" in resolved) return { stay: resolved.error };
  return { ...resolved, step: current.escalated + 1 };
}

/** The lines a task's definition starts with to request a runner by tier. */
export interface TaskHeader {
  runner?: string;
  effort?: string;
  tier?: string;
  /** Why this tier: one line, for whoever audits the choice. Never part of an argv. */
  reason?: string;
  /** How many times the task already moved up a tier. */
  escalated?: number;
}

/** The longest `tier-reason:` line a header carries. */
export const TIER_REASON_LIMIT = 200;

/**
 * The header lines, in the order the worker documents, then one blank line;
 * empty when there is nothing to say. The blank line ends the header, so text
 * that follows — a person's own words — is never read as another hint.
 * Values are written as given: callers pass only names from the policy and a
 * one-line reason.
 */
export function renderTaskHeader(header: TaskHeader): string {
  const lines = [
    ...(header.runner === undefined ? [] : [`runner: ${header.runner}`]),
    ...(header.effort === undefined ? [] : [`effort: ${header.effort}`]),
    ...(header.tier === undefined ? [] : [`tier: ${header.tier}`]),
    ...(header.reason === undefined
      ? []
      : [`tier-reason: ${header.reason.replace(/\s+/g, " ").trim().slice(0, TIER_REASON_LIMIT)}`]),
    ...(header.escalated === undefined || header.escalated === 0
      ? []
      : [`escalated: ${String(header.escalated)}`]),
  ];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}

const RUNNER_LINE = /^\s*runner:\s*([a-z][a-z0-9-]{0,31})\s*$/i;
const EFFORT_LINE = /^\s*effort:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})\s*$/;
const TIER_LINE = /^\s*tier:\s*([a-z][a-z0-9-]{0,31})\s*$/;
/** Audit text, never part of an argv: one line, bounded, read only to be shown. */
const TIER_REASON_LINE = new RegExp(
  `^\\s*tier-reason:\\s*(\\S.{0,${String(TIER_REASON_LIMIT - 1)}})$`,
);
const ESCALATED_LINE = /^\s*escalated:\s*([0-9]{1,2})\s*$/;
/**
 * A header line that starts like an `effort:` hint but is not one. Used only
 * to explain why a line that looks like a hint was left in the prompt; it
 * never selects a level.
 */
const EFFORT_LOOKALIKE = /^\s*effort\s*:/i;
/** A header line that starts like `tier:` but is not one. The task is not run on a guess. */
const TIER_LOOKALIKE = /^\s*tier\s*:/i;
/** At most this many header lines: one of each kind. */
const HEADER_LINES = 5;

/** What a task's header lines ask for, and the text after them. */
export interface ParsedTaskHeader {
  runner?: string;
  effort?: string;
  tier?: string;
  /** Why that tier was chosen, as its requester wrote it. Shown, never run. */
  tierReason?: string;
  /** How many times the task already moved up a tier. */
  escalated?: number;
  prompt: string;
  /** Why a line that looks like an `effort:` hint was left in the prompt. */
  refused?: string;
  /**
   * Why a line that looks like a `tier:` hint is not one. A task that asked
   * for a tier nobody can read is not run at all: running it on the default
   * runner would silently swap the model it asked for.
   */
  refusedTier?: string;
}

/**
 * Read the optional header lines of a task definition: `runner: <name>`,
 * `effort: <level>`, `tier: <name>`, `tier-reason: <text>`, `escalated: <n>`.
 *
 * Every one of them is data from a peer. `runner`, `effort`, and `tier` can
 * only pick a name or a level; the argv and the allow-list come from the
 * machine's policy, so a hint can never add a command or an argument of its
 * own. `tier-reason` is audit text and `escalated` a counter; neither reaches
 * an argv. The lines are stripped from the prompt either way, so a hint is
 * never also part of the text an agent reads.
 *
 * At most one of each, in any order, before the first line that is not a
 * header line; a blank line ends the header and is dropped.
 */
export function parseTaskHeader(definition: string): ParsedTaskHeader {
  const lines = definition.split("\n");
  let index = 0;
  let runner: string | undefined;
  let effort: string | undefined;
  let tier: string | undefined;
  let tierReason: string | undefined;
  let escalated: number | undefined;
  let refused: string | undefined;
  let refusedTier: string | undefined;
  const take = (taken: boolean, pattern: RegExp, line: string): string | undefined =>
    taken ? undefined : pattern.exec(line)?.[1];
  while (index < lines.length && index < HEADER_LINES) {
    const line = lines[index] as string;
    const runnerMatch = take(runner !== undefined, RUNNER_LINE, line);
    if (runnerMatch !== undefined) {
      runner = runnerMatch.toLowerCase();
      index += 1;
      continue;
    }
    const effortMatch = take(effort !== undefined, EFFORT_LINE, line);
    if (effortMatch !== undefined) {
      effort = effortMatch;
      index += 1;
      continue;
    }
    const tierMatch = take(tier !== undefined, TIER_LINE, line);
    if (tierMatch !== undefined) {
      tier = tierMatch;
      index += 1;
      continue;
    }
    const reasonMatch = take(tierReason !== undefined, TIER_REASON_LINE, line);
    if (reasonMatch !== undefined) {
      tierReason = reasonMatch.trim();
      index += 1;
      continue;
    }
    const escalatedMatch = take(escalated !== undefined, ESCALATED_LINE, line);
    if (escalatedMatch !== undefined) {
      escalated = Number(escalatedMatch);
      index += 1;
      continue;
    }
    if (effort === undefined && EFFORT_LOOKALIKE.test(line)) {
      // Not a hint: the level is not one token. Leave the line alone — it is
      // the requester's text — and say that it was not applied.
      refused = `effort hint '${line.trim()}' is malformed (expected 'effort: <level>' with one level on the line); it is kept in the prompt and not applied`;
    }
    if (tier === undefined && TIER_LOOKALIKE.test(line)) {
      refusedTier = `tier hint '${line.trim().slice(0, 80)}' is malformed (expected 'tier: <name>' with one name on the line), so the task is not run on another runner instead`;
    }
    break;
  }
  if (index === 0 && refused === undefined && refusedTier === undefined) {
    return { prompt: definition };
  }
  return {
    ...(runner === undefined ? {} : { runner }),
    ...(effort === undefined ? {} : { effort }),
    ...(tier === undefined ? {} : { tier }),
    ...(tierReason === undefined ? {} : { tierReason }),
    ...(escalated === undefined ? {} : { escalated }),
    ...(refused === undefined ? {} : { refused }),
    ...(refusedTier === undefined ? {} : { refusedTier }),
    prompt: lines
      .slice(index)
      .join("\n")
      .replace(/^\s*\n/, ""),
  };
}
