/**
 * What a finished run publishes, decided from its result alone.
 *
 * Pure, like `select.ts` and `lifecycle.ts`: the rules that turn an exit code,
 * a `result.json`, and the task's attempt count into `completed`, `blocked`, or
 * `released` are testable without a backend or a child process.
 */

import { hasSecrets, type WorkerPolicy } from "@oguri/core";

import { QUESTION_LIMIT, resultRefs, type ResultRead } from "./result.ts";
import { failureAction } from "./retry.ts";
import type { RunResult } from "./runner.ts";
import { SUMMARY_LIMIT, failureReason, succeeded, summarise } from "./summary.ts";

export interface RunReport {
  action: "completed" | "blocked" | "released" | "progressed";
  body: string;
  refs: string[];
  needsHuman: boolean;
}

export interface ReportInput {
  result: RunResult;
  read: ResultRead;
  runner: string;
  /** Claims accepted so far, this run's included. */
  attempt: number;
  maxAttempts?: number;
  policy: Pick<WorkerPolicy, "timeoutMinutes" | "retry">;
  /** `<agent>:<run-dir>`, where the full log is. */
  where: string;
  /** This machine, for `artifact:` refs. */
  machine: string;
  /** Directory the run worked in; relative artifact paths resolve against it. */
  cwd: string;
  /** The run's own worktree branch, when its runner uses one. */
  branch?: string;
  /**
   * Subtasks of this task that have not completed, read after the run. A run
   * that split its task into subtasks has not finished it; the parent
   * completes through the roll-up once they do.
   */
  openChildren?: number;
}

function question(text: string): string {
  if (hasSecrets(text)) return "(withheld: the secret scanner flagged it; see the run log)";
  if (Buffer.byteLength(text, "utf8") <= QUESTION_LIMIT) return text;
  return `${Buffer.from(text, "utf8")
    .subarray(0, QUESTION_LIMIT)
    .toString("utf8")
    .replace(/\uFFFD+$/, "")}…`;
}

/**
 * Decide the report for one run.
 *
 * - Success, no question: `completed`, or `progressed` while subtasks the run
 *   created are still open.
 * - `needsHuman` in `result.json`, whatever the exit code: `blocked` with
 *   `needs: human`, because the agent itself said a person must decide.
 * - Failure: `released` while attempts remain and the policy allows it,
 *   otherwise `blocked`; `needs: human` once attempts are used up.
 */
export function buildReport(input: ReportInput): RunReport {
  const structured = input.read.kind === "valid" ? input.read.result : undefined;
  const { refs, dropped } = resultRefs({
    ...(structured === undefined ? {} : { result: structured }),
    ...(input.branch === undefined ? {} : { worktreeBranch: input.branch }),
    machine: input.machine,
    cwd: input.cwd,
  });
  const base = {
    runner: input.runner,
    where: input.where,
    timeoutMinutes: input.policy.timeoutMinutes,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(structured === undefined ? {} : { structured: structured.summary }),
    ...(input.read.kind === "invalid" ? { invalidResult: input.read.reason } : {}),
  };
  const withDropped = (body: string): string =>
    dropped === 0
      ? body
      : `${body}\n${String(dropped)} result ref(s) were left out: the secret scanner flagged them.`;

  if (structured?.needsHuman !== undefined) {
    const body = summarise(input.result, {
      ...base,
      next: `It needs a person before it can finish.\n\nQuestion: ${question(structured.needsHuman)}`,
    });
    return { action: "blocked", body: withDropped(body), refs, needsHuman: true };
  }

  if (succeeded(input.result)) {
    const open = input.openChildren ?? 0;
    if (open > 0) {
      const body = summarise(input.result, {
        ...base,
        next: `Waiting for ${String(open)} subtask(s); the task completes when they do.`,
      });
      return { action: "progressed", body: withDropped(body), refs, needsHuman: false };
    }
    return {
      action: "completed",
      body: withDropped(summarise(input.result, base)),
      refs,
      needsHuman: false,
    };
  }

  const next = failureAction(
    {
      attempt: input.attempt,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    },
    input.policy.retry,
  );
  const attempts =
    input.maxAttempts === undefined
      ? ""
      : ` (attempt ${String(input.attempt)} of ${String(input.maxAttempts)})`;
  const body = summarise(input.result, {
    ...base,
    next:
      next.action === "released"
        ? `Released for another try${attempts}; any eligible machine may take it.`
        : `Blocked${attempts}: ${next.reason}.`,
  });
  return {
    action: next.action,
    body: withDropped(body),
    refs,
    needsHuman: next.action === "blocked" && next.needsHuman,
  };
}

/** The short, output-free report tried when the full one was refused. */
export function fallbackReport(
  result: RunResult,
  timeoutMinutes: number,
  error: string,
  where: string,
): string {
  const outcome = succeeded(result) ? "success" : failureReason(result, timeoutMinutes);
  return `Worker run ended (${outcome}), but its report was refused: ${error}. Full log: ${where}`.slice(
    0,
    SUMMARY_LIMIT,
  );
}
