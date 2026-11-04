/**
 * Take a task: approve it when the requester is trusted, then claim it.
 *
 * The claim is where the task graph says no (ADR 0027). The agenda was read a
 * moment earlier, and another machine may have moved the graph since, so a
 * graph refusal is an expected race rather than a fault. The worker reports it
 * once and moves on.
 */

import { describeError, type WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import type { Retake } from "./followup.ts";
import { claimRefusal } from "./lifecycle.ts";
import type { Candidate } from "./select.ts";

export type ClaimOutcome =
  /** Ours now; `attempt` is the task's claim count including this one. */
  | { claimed: true; attempt: number }
  /** Not ours. `quiet` reasons repeat every pass and are logged once by the caller. */
  | { claimed: false; reason: string; quiet: boolean; key: string };

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function claimCandidate(
  backend: Backend,
  agentId: string,
  candidate: Candidate,
  policy: WorkerPolicy,
): Promise<ClaimOutcome> {
  // A follow-up claims a task this worker already ran, so its approval is on
  // record already: a person approved it, or the worker did for a trusted
  // requester. Approving again would only write a second record of the same
  // decision. The claim still goes through the gate, so a revoked approval
  // still stops it.
  if (
    candidate.relation !== "followup" &&
    candidate.creator !== agentId &&
    policy.trustedRequesters.includes(candidate.creator)
  ) {
    await backend.call("approve", {
      kind: "task",
      room: candidate.room,
      id: candidate.taskId,
      note: `auto-approved by worker: ${candidate.creator} is in worker.trustedRequesters`,
    });
  }
  try {
    const message = await backend.call<Message | undefined>("taskClaim", {
      room: candidate.room,
      taskId: candidate.taskId,
      body:
        candidate.relation === "followup"
          ? `Claimed again by worker ${agentId} (runner ${candidate.runner}) for a follow-up in the thread.`
          : `Claimed by worker ${agentId} (runner ${candidate.runner}).`,
      // The claim event asserts what the task requires from these, so every
      // reader can check the claim from the event alone.
      ...(policy.capabilities.length === 0 ? {} : { capabilities: policy.capabilities }),
    });
    return { claimed: true, attempt: message?.header?.task?.attempt ?? candidate.attempt + 1 };
  } catch (error) {
    const code = errorCode(error);
    if (code === "APPROVAL_REQUIRED") {
      return {
        claimed: false,
        reason: `awaiting approval from ${candidate.creator}: oguri task approve ${candidate.room} ${candidate.taskId}`,
        quiet: true,
        key: candidate.taskId,
      };
    }
    const refusal = claimRefusal(code);
    if (refusal !== null) {
      return {
        claimed: false,
        reason: `${refusal}: ${describeError(error)}`,
        quiet: true,
        key: `${code ?? ""}:${candidate.taskId}`,
      };
    }
    return {
      claimed: false,
      reason: `claim failed: ${describeError(error)}`,
      quiet: false,
      key: candidate.taskId,
    };
  }
}

/**
 * Take a task back for a follow-up (ADR 0030 §5).
 *
 * A completed task this agent created is reopened, then claimed; an open task
 * is claimed. A task this agent still holds needs nothing here. A completed
 * task someone else created stays completed: only its creator may reopen it,
 * so the follow-up is answered in the thread instead.
 */
export async function retakeTask(
  backend: Backend,
  agentId: string,
  candidate: Candidate,
  retake: Retake,
  policy: WorkerPolicy,
): Promise<ClaimOutcome> {
  if (retake === "start" || retake === "continue" || retake === "reply") {
    return { claimed: true, attempt: candidate.attempt };
  }
  if (retake === "reopen") {
    try {
      await backend.call("taskUpdate", {
        room: candidate.room,
        taskId: candidate.taskId,
        input: {
          action: "reopened",
          body: `Reopened by worker ${agentId}: a person followed up in the thread.`,
        },
      });
    } catch (error) {
      return {
        claimed: false,
        reason: `reopen failed: ${describeError(error)}`,
        quiet: false,
        key: candidate.taskId,
      };
    }
  }
  return await claimCandidate(backend, agentId, candidate, policy);
}
