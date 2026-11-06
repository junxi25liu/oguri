/**
 * Which assigned tasks this worker may take, and with which runner.
 *
 * Pure, so the rules that decide what runs on a machine are testable without
 * git, a daemon, or a child process.
 */

import type { Agenda, ParsedTaskHeader, RunnerGate, SessionMode, WorkerPolicy } from "@oguri/core";
import {
  allowListGate,
  effortConflict,
  findTier,
  parseTaskHeader,
  resolveTier,
  runnerAvailability,
  withRunnerEffort,
  withRunnerModel,
} from "@oguri/core";
import type { Priority, TaskOrigin } from "@oguri/protocol";

/** A task the worker may claim and run now. */
export interface Candidate {
  room: string;
  taskId: string;
  title: string;
  creator: string;
  /** The task text with its header lines (`runner:`, `effort:`, `tier:`, ...) removed. This is what the executor reads. */
  prompt: string;
  runner: string;
  argv: string[];
  /** The tier the task asked for, when it asked for one (ADR 0034). */
  tier?: string;
  /** The task's `tier-reason:` line: why its requester chose that tier. */
  tierReason?: string;
  /** How many times the task already moved up a tier. */
  escalated?: number;
  /** Who chose the effort in `argv`: the task's header, a follow-up, or the policy. */
  effortSource?: "follow-up" | "task" | "tier" | "policy";
  /** The runner's own directory, when it names one. */
  workdir?: string;
  /** Run in a fresh git worktree of the workdir. */
  worktree: boolean;
  /** Argv that continues a session, with `{session}` once. */
  resume?: string[];
  /** Where the runner reports its session id. */
  session?: SessionMode;
  /** The runner's `oguriTools`, when set. */
  oguriTools?: boolean;
  /** The task's thread, where relay messages and follow-ups go. */
  thread?: string;
  /** The chat the task was requested from (ADR 0030). Relay messages are posted only when set. */
  origin?: TaskOrigin;
  /**
   * Why it is here: addressed to this agent or machine, matched by
   * capability, or a person's follow-up on a task this worker ran.
   */
  relation: "offered" | "capable" | "followup";
  /** Claims accepted before this one. */
  attempt: number;
  /** The task's claim limit, when it has one. */
  maxAttempts?: number;
  /** The task this is a subtask of, in the same room. */
  parent?: string;
  /** Tasks that completed before this one became ready. */
  dependsOn?: string[];
  /** The priority its creator gave it, which decides the order below. */
  priority: Priority;
}

/** A task addressed here that the worker will not run, and why. */
export interface Skipped {
  room: string;
  taskId: string;
  reason: string;
}

export interface Selection {
  candidates: Candidate[];
  skipped: Skipped[];
  /**
   * Tasks that run anyway, with a note worth saying once: today, a task whose
   * `effort:` hint was not on the runner's allow-list and so was ignored.
   */
  notices: Skipped[];
  /**
   * Tasks addressed here that cannot be claimed yet: a dependency has not
   * completed, or no attempt is left. Not a refusal, so not in `skipped`.
   */
  waiting: Skipped[];
}

/** What a task's header lines ask for (ADR 0034). */
export type RunnerHint = ParsedTaskHeader;

/**
 * Read the optional header lines of a task definition: `runner: <name>`,
 * `effort: <level>`, `tier: <name>`, `tier-reason: <text>`, `escalated: <n>`.
 *
 * Every one of them is a hint, and data from a peer. `runner`, `effort`, and
 * `tier` can only pick a name or a level; the argv and the allow-list come
 * from this machine's policy, so a hint can never add a command or an
 * argument of its own. The lines are stripped from the prompt either way, so
 * a hint is never also part of the text an agent reads.
 *
 * `runner:` has always been the first line. The rest are read next to it, at
 * most one of each, in any order, before the first line of the body:
 *
 * ```text
 * runner: claude
 * effort: high
 * tier: standard
 * tier-reason: touches three packages and their tests
 * Fix the flaky login test.
 * ```
 *
 * A header line that starts with `effort:` but carries anything else — say,
 * `effort: max --tools=all` — is not a hint. It stays in the prompt, and
 * `refused` says why, so a malformed hint is never a silent no-op. A malformed
 * `tier:` line is reported in `refusedTier`, and the worker does not run it.
 * The parser itself is `parseTaskHeader` in core, which the superagents use to
 * write the same lines.
 */
export function parseRunnerHint(definition: string): RunnerHint {
  return parseTaskHeader(definition);
}

/**
 * The effort to run with, from a task's hint and the runner's allow-list.
 *
 * A task may only pick a level the machine owner listed for that runner. It
 * never supplies free text: an unlisted or malformed value is ignored and the
 * runner's configured `effort` applies, so the default behaviour is unchanged
 * for every task today, and a typo on the network can never reach an argv.
 *
 * Returns the level to run with and, when a hint was ignored, why — so the
 * worker can say so once instead of silently doing something else.
 */
export function resolveEffort(
  runner: { effort?: string; efforts?: readonly string[] },
  hint: string | undefined,
): { effort?: string; ignored?: string } {
  const allowed = runner.efforts ?? [];
  if (hint === undefined) {
    return runner.effort === undefined ? {} : { effort: runner.effort };
  }
  if (allowed.includes(hint)) return { effort: hint };
  const listed = allowed.length === 0 ? "none" : allowed.join(", ");
  return {
    ...(runner.effort === undefined ? {} : { effort: runner.effort }),
    ignored: `effort '${hint}' is not allowed for this runner (allowed: ${listed})`,
  };
}

/**
 * Map a hint to an allow-listed runner, or explain why there is none.
 *
 * `effortHint` comes from the task's own first lines and can only select a
 * level the runner lists in `efforts`; see `resolveEffort`. `gate` can only
 * narrow the allow-list (ADR 0034): a runner it refuses is an error, never a
 * reason to pick another.
 */
export function resolveRunner(
  policy: WorkerPolicy,
  hint: string | undefined,
  effortHint?: string,
  gate: RunnerGate = allowListGate,
):
  | {
      name: string;
      argv: string[];
      workdir?: string;
      worktree: boolean;
      resume?: string[];
      session?: SessionMode;
      oguriTools?: boolean;
      /** A task's effort hint was not on this runner's allow-list. */
      ignoredEffort?: string;
      /** The argv already chose another level, so the hint is not applied. */
      conflictedEffort?: string;
    }
  | { error: string } {
  const names = Object.keys(policy.runners);
  const name = hint ?? policy.defaultRunner ?? names[0];
  if (name === undefined) return { error: "no runner is configured under worker.runners" };
  const runner = policy.runners[name];
  if (runner === undefined) {
    return {
      error: `runner '${name}' is not allowed here (allowed: ${names.join(", ") || "none"})`,
    };
  }
  const available = runnerAvailability(policy, name, gate);
  if (!available.ok) return { error: available.reason };
  // The level the owner configured is already in the policy; a hint can only
  // pick another one the owner listed.
  const chosen = resolveEffort(runner, effortHint);
  const argv = withRunnerEffort(withRunnerModel(runner.argv, runner.model), chosen.effort);
  const resume =
    runner.resume === undefined
      ? undefined
      : withRunnerEffort(withRunnerModel(runner.resume, runner.model), chosen.effort);
  // When a task's hint was applied but an argv still carries a different
  // level, the owner's flag wins. Say so once instead of appearing to honour
  // the hint. Only a request is reported here: an owner's own `effort:` key
  // disagreeing with their own argv is a policy question, not a task's.
  const applied = chosen.ignored === undefined && effortHint !== undefined;
  const argvConflict = applied ? effortConflict(runner.argv, chosen.effort) : undefined;
  const resumeConflict =
    applied && runner.resume !== undefined
      ? effortConflict(runner.resume, chosen.effort, "resume argv")
      : undefined;
  return {
    name,
    argv,
    ...(runner.workdir === undefined ? {} : { workdir: runner.workdir }),
    worktree: runner.worktree,
    ...(resume === undefined ? {} : { resume }),
    ...(runner.session === undefined ? {} : { session: runner.session }),
    ...(runner.oguriTools === undefined ? {} : { oguriTools: runner.oguriTools }),
    ...(chosen.ignored === undefined ? {} : { ignoredEffort: chosen.ignored }),
    ...(argvConflict === undefined && resumeConflict === undefined
      ? {}
      : {
          conflictedEffort: [argvConflict, resumeConflict]
            .filter((part) => part !== undefined)
            .join("; "),
        }),
  };
}

/**
 * Resolve a task's whole header to a runner: by tier when it names one, else
 * by runner name as before.
 *
 * A tier request is checked against this machine's `worker.tiers` and
 * `gate`. When it cannot be honoured the task is refused with the reason,
 * never run on some other runner: the requester picked that tier for a
 * reason, and a silent swap would be exactly the substitution the run record
 * exists to rule out. `effortOverride` is a follow-up's own `effort:` line,
 * which outranks the task's.
 */
export function resolveHint(
  policy: WorkerPolicy,
  hint: Pick<RunnerHint, "runner" | "effort" | "tier" | "refusedTier">,
  gate: RunnerGate = allowListGate,
  effortOverride?: string,
): (ReturnType<typeof resolveRunner> & { tier?: string }) | { error: string } {
  if (hint.refusedTier !== undefined) return { error: hint.refusedTier };
  const effort = effortOverride ?? hint.effort;
  if (hint.tier === undefined) return resolveRunner(policy, hint.runner, effort, gate);
  const tier = resolveTier(
    policy,
    {
      tier: hint.tier,
      ...(hint.runner === undefined ? {} : { runner: hint.runner }),
      ...(effort === undefined ? {} : { effort }),
    },
    gate,
  );
  if ("error" in tier) return tier;
  const resolved = resolveRunner(policy, tier.runner, tier.effort, gate);
  return "error" in resolved ? resolved : { ...resolved, tier: tier.tier };
}

/**
 * Who chose the effort a run asks for, when its argv asks for one: the task
 * (or a follow-up) whose hint was applied, else the machine's policy.
 */
export function effortSourceOf(
  asked: string | undefined,
  resolved: { argv: readonly string[]; ignoredEffort?: string; conflictedEffort?: string },
  source: "follow-up" | "task" | "tier" = "task",
): { effortSource: "follow-up" | "task" | "tier" | "policy" } | undefined {
  if (!resolved.argv.includes("--effort") && !resolved.argv.some((p) => p.startsWith("--effort=")))
    return undefined;
  const applied =
    asked !== undefined &&
    resolved.ignoredEffort === undefined &&
    resolved.conflictedEffort === undefined;
  return { effortSource: applied ? source : "policy" };
}

/** Why an entry the agenda marks not ready cannot be claimed now. */
function notReadyReason(entry: Agenda["entries"][number], capabilities: readonly string[]): string {
  const { waitingOn, task } = entry.status;
  if (waitingOn.length > 0) {
    return `waiting on ${waitingOn.map((link) => `${link.id} (${link.state})`).join(", ")}`;
  }
  if (task.maxAttempts !== undefined && (task.attempt ?? 0) >= task.maxAttempts) {
    return `all ${String(task.maxAttempts)} attempt(s) are used`;
  }
  const missing = (task.requires ?? []).filter((name) => !capabilities.includes(name));
  if (missing.length > 0) {
    return `requires ${missing.join(", ")}, which worker.capabilities does not list`;
  }
  return "not claimable here yet";
}

/**
 * Pick open tasks this worker may claim.
 *
 * `offered` entries qualify: a task someone addressed to this agent or this
 * machine on purpose. So do `capable` entries, which the agenda lists only
 * when the worker asked with its `worker.capabilities`: free work that names
 * required capabilities has chosen machines by what they can do. A plain free
 * task is left to people and live agents, because nobody chose this machine
 * to spend money on it.
 *
 * Only `ready` entries are taken (ADR 0027). Anything else would be refused at
 * the claim anyway.
 */
export function selectCandidates(
  agenda: Agenda,
  policy: WorkerPolicy,
  exclude: ReadonlySet<string> = new Set(),
  gate: RunnerGate = allowListGate,
): Selection {
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  const notices: Skipped[] = [];
  const waiting: Skipped[] = [];
  for (const entry of agenda.entries) {
    const task = entry.status.task;
    const relation = entry.relation;
    if ((relation !== "offered" && relation !== "capable") || task.state !== "open") continue;
    if (exclude.has(task.id)) continue;
    if (entry.ready !== true) {
      waiting.push({
        room: entry.room,
        taskId: task.id,
        reason: notReadyReason(entry, policy.capabilities),
      });
      continue;
    }

    const header = parseRunnerHint(entry.status.definition);
    const { prompt, refused: refusedEffort } = header;
    const resolved = resolveHint(policy, header, gate);
    if ("error" in resolved) {
      skipped.push({ room: entry.room, taskId: task.id, reason: resolved.error });
      continue;
    }
    // Everything the requester should hear about the effort that ran. Said as
    // one notice: the worker logs a notice once per task, so a second reason
    // would be dropped.
    const effortReasons: string[] = [];
    if (resolved.ignoredEffort !== undefined) {
      // The task still runs; its effort hint was refused, not obeyed. Reported
      // as a notice rather than a skip, so a requester learns why the run uses
      // the runner's own level.
      effortReasons.push(`${resolved.ignoredEffort}; running at the runner's configured level`);
    }
    if (refusedEffort !== undefined) {
      // A header line that looked like a hint but is not one. It never reached
      // an argv and is still the task's own text, so the run goes ahead.
      effortReasons.push(refusedEffort);
    }
    if (resolved.conflictedEffort !== undefined) {
      // The task runs, but not at the level it asked for: the machine owner's
      // argv already chose another one, and that choice stands.
      effortReasons.push(resolved.conflictedEffort);
    }
    if (effortReasons.length > 0) {
      notices.push({ room: entry.room, taskId: task.id, reason: effortReasons.join("; ") });
    }
    if (prompt.trim().length === 0) {
      skipped.push({ room: entry.room, taskId: task.id, reason: "the task has no instructions" });
      continue;
    }
    candidates.push({
      room: entry.room,
      taskId: task.id,
      title: task.title,
      creator: task.creator,
      prompt,
      runner: resolved.name,
      argv: resolved.argv,
      ...(resolved.tier === undefined ? {} : { tier: resolved.tier }),
      ...(header.tierReason === undefined ? {} : { tierReason: header.tierReason }),
      ...(header.escalated === undefined ? {} : { escalated: header.escalated }),
      ...effortSourceOf(
        header.effort ??
          (resolved.tier === undefined ? undefined : findTier(policy, resolved.tier)?.effort),
        resolved,
        header.effort === undefined ? "tier" : "task",
      ),
      ...(resolved.workdir === undefined ? {} : { workdir: resolved.workdir }),
      worktree: resolved.worktree,
      ...(resolved.resume === undefined ? {} : { resume: resolved.resume }),
      ...(resolved.session === undefined ? {} : { session: resolved.session }),
      ...(resolved.oguriTools === undefined ? {} : { oguriTools: resolved.oguriTools }),
      ...(entry.status.thread === undefined ? {} : { thread: entry.status.thread }),
      ...(task.origin === undefined ? {} : { origin: task.origin }),
      relation,
      attempt: task.attempt ?? 0,
      ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
      ...(task.parent === undefined ? {} : { parent: task.parent }),
      ...(task.dependsOn === undefined || task.dependsOn.length === 0
        ? {}
        : { dependsOn: [...task.dependsOn] }),
      priority: entry.status.priority,
    });
  }
  // The order the worker claims in, which is not the order the agenda shows.
  // The agenda ranks by attention and then by the oldest silence, so a task
  // that was released after a failed run drops to the back however early it
  // was created. For taking work that is the wrong question: what a queue
  // needs is the requester's stated priority, and a stable place within it.
  candidates.sort(compareCandidates);
  return { candidates, skipped, notices, waiting };
}

/** Lower is claimed first. */
const PRIORITY_RANK: Record<Priority, number> = {
  blocking: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Which ready candidate the worker takes first (ADR 0035).
 *
 * Priority, then the task id. A task id is a ULID, and its leading timestamp
 * is the millisecond it was created, so this is creation order: the oldest
 * task of a priority goes first, and a task that has been released and
 * re-queued keeps its original place instead of falling to the back.
 *
 * Only `selectCandidates` sorts. The agenda keeps its own order, which answers
 * "what needs my attention" rather than "what do I take next".
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  // Equal ULIDs cannot happen within one room, but stay deterministic across rooms.
  if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
  return a.room < b.room ? -1 : a.room > b.room ? 1 : 0;
}
