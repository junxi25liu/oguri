/**
 * Rules for a task that changed under a run, or outlived the worker running it.
 *
 * Pure, like `select.ts`: what the worker does to a task is decided here from
 * the task snapshot alone, so the decision is testable without a backend.
 */

import type { AbandonAction } from "@oguri/core";
import type { Task } from "@oguri/protocol";

const TERMINAL = new Set(["completed", "cancelled"]);

/**
 * Why an in-flight run must stop, or null when it may continue.
 *
 * The run is this agent's only while the task says so. A creator who cancels
 * or releases the task, or hands it to someone else, has withdrawn the work,
 * and finishing it anyway would spend money on output nobody will accept.
 */
export function stopReason(task: Task, agentId: string): string | null {
  if (task.state === "cancelled") return "the task was cancelled";
  if (task.assignee === agentId) return null;
  if (task.assignee === undefined) return "the task was released";
  return `the task was reassigned to ${task.assignee}`;
}

/**
 * What to publish for a task whose run was abandoned, or null for nothing.
 *
 * Only a task this agent still holds is touched: one that finished, was
 * cancelled, or moved on while the worker was down is already settled.
 * `blocked` is only valid from claimed or in progress, so a task that is
 * already blocked or stuck is left as it is under `block`.
 */
export function abandonAction(
  task: Task,
  agentId: string,
  onAbandon: AbandonAction,
): "released" | "blocked" | null {
  if (task.assignee !== agentId || TERMINAL.has(task.state) || task.state === "open") return null;
  if (onAbandon === "release") return "released";
  return task.state === "claimed" || task.state === "in_progress" ? "blocked" : null;
}

/**
 * The claim refusals the task graph produces, as a short reason (ADR 0027).
 *
 * Each is an expected race, not a fault: the agenda said the task was ready a
 * moment before another machine completed a dependency's reopen, used the last
 * attempt, or the profile changed. Null for any other code.
 */
export function claimRefusal(code: string | undefined): string | null {
  switch (code) {
    case "DEPENDENCY_PENDING":
      return "a dependency is not completed";
    case "ATTEMPTS_EXHAUSTED":
      return "no attempt is left";
    case "CAPABILITY_MISSING":
      return "a required capability is not declared here";
    default:
      return null;
  }
}
