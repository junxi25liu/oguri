/**
 * Which assigned tasks this worker may take, and with which runner.
 *
 * Pure, so the rules that decide what runs on a machine are testable without
 * git, a daemon, or a child process.
 */

import type { Agenda, SessionMode, WorkerPolicy } from "@oguri/core";
import { withRunnerModel } from "@oguri/core";
import type { TaskOrigin } from "@oguri/protocol";

/** A task the worker may claim and run now. */
export interface Candidate {
  room: string;
  taskId: string;
  title: string;
  creator: string;
  /** The task text with any `runner:` line removed. This is what the executor reads. */
  prompt: string;
  runner: string;
  argv: string[];
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
   * Tasks addressed here that cannot be claimed yet: a dependency has not
   * completed, or no attempt is left. Not a refusal, so not in `skipped`.
   */
  waiting: Skipped[];
}

const RUNNER_LINE = /^\s*runner:\s*([a-z][a-z0-9-]{0,31})\s*$/i;

/**
 * Read an optional `runner: <name>` first line from a task definition.
 *
 * The hint is data from a peer. It can only pick a name; the argv it maps to
 * comes from this machine's policy, so a hint can never add a command.
 */
export function parseRunnerHint(definition: string): { runner?: string; prompt: string } {
  const newline = definition.indexOf("\n");
  const first = newline === -1 ? definition : definition.slice(0, newline);
  const match = RUNNER_LINE.exec(first);
  if (match === null) return { prompt: definition };
  const rest = newline === -1 ? "" : definition.slice(newline + 1);
  return { runner: (match[1] as string).toLowerCase(), prompt: rest.replace(/^\s*\n/, "") };
}

/** Map a hint to an allow-listed runner, or explain why there is none. */
export function resolveRunner(
  policy: WorkerPolicy,
  hint: string | undefined,
):
  | {
      name: string;
      argv: string[];
      workdir?: string;
      worktree: boolean;
      resume?: string[];
      session?: SessionMode;
      oguriTools?: boolean;
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
  return {
    name,
    argv: withRunnerModel(runner.argv, runner.model),
    ...(runner.workdir === undefined ? {} : { workdir: runner.workdir }),
    worktree: runner.worktree,
    ...(runner.resume === undefined
      ? {}
      : { resume: withRunnerModel(runner.resume, runner.model) }),
    ...(runner.session === undefined ? {} : { session: runner.session }),
    ...(runner.oguriTools === undefined ? {} : { oguriTools: runner.oguriTools }),
  };
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
): Selection {
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
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

    const { runner: hint, prompt } = parseRunnerHint(entry.status.definition);
    const resolved = resolveRunner(policy, hint);
    if ("error" in resolved) {
      skipped.push({ room: entry.room, taskId: task.id, reason: resolved.error });
      continue;
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
    });
  }
  return { candidates, skipped, waiting };
}
