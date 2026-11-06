/**
 * The runner-grant gate in front of every run (see `@oguri/core` runner-grants).
 *
 * Applied after selection and before a claim, so a refused task is never
 * claimed: it stays open, addressed here, and runs on the first pass after a
 * person grants its runner. Nothing is cached, so a revoke refuses the next
 * pass with no restart.
 *
 * Kept out of `select.ts` on purpose: selection is pure and decides which
 * runner a task asked for; this decides whether that runner may start now,
 * which needs the machine's grants file.
 */

import {
  RunnerGrantStore,
  checkGrant,
  describeError,
  type Agenda,
  type GrantState,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { parseRunnerHint, type Candidate, type Skipped } from "./select.ts";

/** Tag on the message a worker writes when a task waits for a runner grant. */
export const RUNNER_REQUEST_TAG = "runner-request";
/** The tag the big superagent passes on to the owner (`QUESTION_TAG` in superagent/src/big.ts). */
const QUESTION_TAG = "task-question";

export interface GateContext {
  store: RunnerGrantStore;
  backend: Backend;
  agentId: string;
  policy: WorkerPolicy;
  /** Log a line once per key. */
  note: (key: string, line: string) => void;
}

/**
 * The candidates whose runner may run now, and why the others may not.
 *
 * A refusal records one request per task and runner, so the person sees what
 * is waiting and why. Nothing stops: the task waits, open, for the grant.
 */
export async function gateCandidates(
  context: GateContext,
  candidates: readonly Candidate[],
): Promise<{ allowed: Candidate[]; refused: Skipped[] }> {
  if (candidates.length === 0) return { allowed: [], refused: [] };
  const state = await readState(context);
  if (!state.enforced) return { allowed: [...candidates], refused: [] };

  const allowed: Candidate[] = [];
  const refused: Skipped[] = [];
  for (const candidate of candidates) {
    const runner = context.policy.runners[candidate.runner];
    const verdict =
      runner === undefined
        ? { allowed: false as const, reason: `runner '${candidate.runner}' is not configured` }
        : checkGrant(state, candidate.runner, runner, candidate.creator);
    if (verdict.allowed) {
      allowed.push(candidate);
      continue;
    }
    refused.push({ room: candidate.room, taskId: candidate.taskId, reason: verdict.reason });
    await requestFor(context, candidate.runner, candidate, verdict.reason);
  }
  return { allowed, refused };
}

/**
 * Ask the person for runners that tasks addressed here named but this machine
 * does not have at all. Selection already skipped those tasks; this turns the
 * skip into a request a person can act on, instead of a log line only.
 */
export async function requestMissingRunners(
  context: GateContext,
  agenda: Agenda,
  skipped: readonly Skipped[],
): Promise<void> {
  for (const skip of skipped) {
    const entry = agenda.entries.find((candidate) => candidate.status.task.id === skip.taskId);
    if (entry === undefined) continue;
    const hint = parseRunnerHint(entry.status.definition).runner;
    if (hint === undefined || context.policy.runners[hint] !== undefined) continue;
    await requestFor(
      context,
      hint,
      {
        room: entry.room,
        taskId: skip.taskId,
        creator: entry.status.task.creator,
        ...(entry.status.thread === undefined ? {} : { thread: entry.status.thread }),
      },
      "it is not in worker.runners here; a person adds it to policy.yaml (and grants it, when grants are on)",
    );
  }
}

async function readState(context: GateContext): Promise<GrantState> {
  try {
    return await context.store.state();
  } catch (error) {
    // Unreadable is not absent: a person may have turned grants on, so
    // nothing runs until the file can be read again.
    context.note("grants:read", `could not read runner grants: ${describeError(error)}`);
    return { enforced: true, corrupt: true, grants: [] };
  }
}

async function requestFor(
  context: GateContext,
  runner: string,
  task: { room: string; taskId: string; creator: string; thread?: string },
  why: string,
): Promise<void> {
  const { store, backend, agentId, note } = context;
  const reason = `task ${task.taskId} from ${task.creator} asks for runner '${runner}': ${why}`;
  let duplicate = true;
  try {
    ({ duplicate } = await store.request({
      runner,
      by: agentId,
      via: "worker",
      reason,
      taskId: task.taskId,
      room: task.room,
    }));
  } catch (error) {
    note(
      `grant-request:${task.taskId}`,
      `could not record a runner request: ${describeError(error)}`,
    );
    return;
  }
  if (duplicate) return;
  note(
    `grant-request:${task.taskId}:${runner}`,
    `${task.taskId} waits for runner '${runner}'; asked this machine's person (oguri runner list)`,
  );
  // Said once in the task's thread, so whoever deployed it — a person, or the
  // big superagent, which passes a worker's question on to the owner — learns
  // that the work waits for a grant rather than that it silently stalled. The
  // message asks; it cannot grant, and nothing reads it as a grant.
  if (task.thread === undefined) return;
  try {
    await backend.call("send", {
      room: task.room,
      input: {
        body: `This task waits for runner '${runner}' on ${agentId}'s machine: ${why}. Nothing was started. The machine's person can grant it at a terminal with: oguri runner grant ${runner}`,
        kind: "question",
        needs: "human",
        thread: task.thread,
        inReplyTo: task.thread,
        tags: [QUESTION_TAG, RUNNER_REQUEST_TAG],
        ...(task.creator === agentId ? {} : { mentions: [task.creator] }),
      },
    });
  } catch (error) {
    note(
      `grant-request-send:${task.taskId}`,
      `could not say in ${task.taskId}'s thread that it waits for a runner: ${describeError(error)}`,
    );
  }
}
