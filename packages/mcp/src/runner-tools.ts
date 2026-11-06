/**
 * `oguri_runner`: what an agent may know and ask about this machine's runner
 * grants (see `@oguri/core` runner-grants).
 *
 * Two actions and no more. `list` reads; `request` appends one line to the
 * request log and the audit trail. Neither can grant, revoke, or create the
 * grants file, so an agent asking can never switch enforcement on or off, and
 * a message from the network reaching this server can at most ask. Granting
 * is `oguri runner grant`, at the machine's terminal.
 */

import { RunnerGrantStore, grantRows, type WorkerRunner } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

export async function runnerList(
  backend: Backend,
  store: RunnerGrantStore,
): Promise<Record<string, unknown>> {
  const resolved = await backend.call<{
    policy: { worker: { runners: Record<string, WorkerRunner> } };
  }>("policy");
  const state = await store.state();
  const rows = grantRows(state, resolved.policy.worker.runners);
  return {
    enforced: state.enforced,
    corrupt: state.corrupt,
    runners: rows.map((row) => ({
      runner: row.runner,
      digest: row.digest,
      // Off means every runner in worker.runners may run.
      allowed: !state.enforced || row.allowed,
      ...(state.enforced && row.reason !== undefined ? { reason: row.reason } : {}),
      ...(row.grant === undefined
        ? {}
        : {
            grantedBy: row.grant.grantedBy.human,
            grantedAt: row.grant.grantedAt,
            ...(row.grant.for === undefined ? {} : { for: row.grant.for }),
            ...(row.grant.expiresAt === undefined ? {} : { expiresAt: row.grant.expiresAt }),
          }),
    })),
    requests: (await store.requests()).slice(-20),
    grantWith: "oguri runner grant <name>  — the machine's person, at a terminal",
  };
}

export async function runnerRequest(
  backend: Backend,
  store: RunnerGrantStore,
  input: { runner: string; reason: string; taskId?: string; room?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const status = await backend.call<{ agentId: string }>("status");
  // A run asks about its own task or a subtask, and only while it is still its own.
  const taskId = input.taskId ?? nonEmpty(env["OGURI_TASK_ID"]);
  const room = input.room ?? nonEmpty(env["OGURI_TASK_ROOM"]);
  await backend.runScope?.assertRequest({ taskId, room });
  const { request, duplicate } = await store.request({
    runner: input.runner,
    by: status.agentId,
    via: "mcp",
    reason: input.reason,
    ...(taskId === undefined ? {} : { taskId }),
    ...(room === undefined ? {} : { room }),
  });
  return {
    request,
    duplicate,
    granted: false,
    note: "Asked. Nothing is granted until this machine's person runs `oguri runner grant` at a terminal; keep working on what does not need the runner, and say what you are waiting for.",
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
