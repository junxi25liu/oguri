/**
 * What a run publishes back to the task.
 *
 * Only this text enters the shared record. It is bounded, and it is checked by
 * the secret scanner before it leaves the machine: an agent's output can echo
 * an environment variable or a config file, and the log is permanent.
 */

import { hasSecrets } from "@oguri/core";

import type { RunResult } from "./runner.ts";

export const SUMMARY_LIMIT = 8 * 1024;

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Keep the end of the output, cut on a line boundary when one is near. */
function tailOf(text: string, limit: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= limit) return { text: trimmed, truncated: false };
  let cut = Buffer.from(trimmed, "utf8").subarray(-limit).toString("utf8");
  const newline = cut.indexOf("\n");
  if (newline !== -1 && newline < 512) cut = cut.slice(newline + 1);
  return { text: cut.replace(/^\uFFFD+/, ""), truncated: true };
}

export function succeeded(result: RunResult): boolean {
  return result.error === undefined && !result.timedOut && result.exitCode === 0;
}

export function failureReason(result: RunResult, timeoutMinutes: number): string {
  if (result.error !== undefined) return `the runner could not start: ${result.error}`;
  if (result.timedOut) return `the run exceeded its ${String(timeoutMinutes)} minute limit`;
  if (result.signal !== null) return `the run was killed by ${result.signal}`;
  return `the runner exited with code ${String(result.exitCode)}`;
}

/** Keep the start of a text the agent wrote for a reader, cut on a line boundary when one is near. */
function headOf(text: string, limit: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= limit) return { text: trimmed, truncated: false };
  let cut = Buffer.from(trimmed, "utf8").subarray(0, limit).toString("utf8");
  const newline = cut.lastIndexOf("\n");
  if (newline !== -1 && cut.length - newline < 512) cut = cut.slice(0, newline);
  return { text: cut.replace(/\uFFFD+$/, ""), truncated: true };
}

export interface SummaryContext {
  runner: string;
  where: string;
  timeoutMinutes: number;
  branch?: string;
  /** The `summary` of a valid `result.json`, used instead of the output. */
  structured?: string;
  /** Why `result.json` was rejected, when it existed and was invalid. */
  invalidResult?: string;
  /**
   * The run exited 0 on a runner that does not require `result.json`, and
   * wrote none. It still completes; the report says the text below is the end
   * of its output, not a result it submitted.
   */
  noResult?: boolean;
  /** What happens next, for a failed run: released for a retry, or blocked. */
  next?: string;
}

/**
 * Build the completion or block message for one run.
 *
 * `where` names the agent and the local log directory, so the person reading
 * the task knows which machine holds the full transcript.
 */
export function summarise(result: RunResult, context: SummaryContext): string {
  const ok = succeeded(result);
  // An exit code of 0 is not a completion when the run's own account of itself
  // was rejected: saying "Done by worker" there is the report that lied.
  const head = [
    context.invalidResult !== undefined && ok
      ? `Worker run ended (runner ${context.runner}, ${formatDuration(result.durationMs)}) but its result.json was rejected, so this is not reported as a completion.`
      : ok
        ? `Done by worker (runner ${context.runner}, ${formatDuration(result.durationMs)}).`
        : `Worker run failed: ${failureReason(result, context.timeoutMinutes)}.`,
    ...(context.next === undefined ? [] : [context.next]),
  ].join(" ");
  const footer =
    context.branch === undefined
      ? `Full log: ${context.where}`
      : `Work is on branch ${context.branch}, in a worktree under the run directory.\nFull log: ${context.where}`;

  if (context.structured !== undefined) {
    const { text, truncated } = headOf(context.structured, SUMMARY_LIMIT);
    if (hasSecrets(text)) {
      return `${head}\n\nSummary withheld: the secret scanner flagged it.\n\n${footer}`;
    }
    return `${head}\n\n${text}${truncated ? "\n\n(summary truncated)" : ""}\n\n${footer}`;
  }

  const note =
    context.invalidResult !== undefined
      ? `result.json was rejected: ${context.invalidResult}. Nothing in it was published; the output is below.\n\n`
      : context.noResult === true && ok
        ? "Note: no result.json was written, so this is the end of the run's output, not a result it submitted.\n\n"
        : "";
  const { text, truncated } = tailOf(result.stdoutTail, SUMMARY_LIMIT);
  if (text.length === 0) return `${head}\n\n${note}${footer}`;
  if (hasSecrets(text)) {
    return `${head}\n\n${note}Output withheld: the secret scanner flagged it.\n\n${footer}`;
  }
  const label = truncated ? "Last part of the output:" : "Output:";
  return `${head}\n\n${note}${label}\n\n${text}\n\n${footer}`;
}
