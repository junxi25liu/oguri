/**
 * Settle what a previous worker left behind, before this one starts any run.
 *
 * A worker killed mid-run — a reboot, `kill -9`, a second Ctrl-C — cannot
 * report anything. Its task stays `in_progress` under this agent and its
 * record stays `running`, and both would stay that way forever: nobody else
 * may take a task this agent holds, and nothing on the network can tell a long
 * run from a dead one. The next start is the only moment that can.
 */

import { describeError, type AbandonAction, type TaskDetail } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { abandonAction } from "./lifecycle.ts";
import { sameProcessAlive } from "./process.ts";
import { killGroup } from "./runner.ts";
import { listRuns, writeRunRecord, type RunRecord } from "./runs.ts";

export interface RecoveryOptions {
  backend: Backend;
  agentId: string;
  home: string;
  onAbandon: AbandonAction;
  log: (line: string) => void;
  now?: () => number;
}

export interface Recovered {
  taskId: string;
  runId?: string;
  /** What was published for the task, or null when it needed nothing. */
  published: "released" | "blocked" | null;
}

/** The record's start time, which bounds when its processes can have started. */
function startOf(record: RunRecord): number {
  return Date.parse(record.startedAt);
}

/**
 * Mark dead `running` records `abandoned`, then settle every abandoned record
 * whose task has not been settled yet.
 *
 * A record whose worker is still alive belongs to another worker process and
 * is left alone. A record whose worker is gone but whose executor survived
 * (it leads its own process group, so killing the worker does not kill it) is
 * an orphan: nobody reads its output or reports its result, so its group is
 * killed before the record is closed.
 */
export async function reconcileRuns(options: RecoveryOptions): Promise<Recovered[]> {
  const { home, log } = options;
  const now = options.now ?? Date.now;
  const records = await listRuns(home, Number.POSITIVE_INFINITY);

  for (const record of records) {
    if (record.outcome !== "running") continue;
    if (await sameProcessAlive(record.workerPid, startOf(record))) continue;
    const spawnedAt =
      record.spawnedAt === undefined ? startOf(record) : Date.parse(record.spawnedAt);
    if (record.pid !== undefined && (await sameProcessAlive(record.pid, spawnedAt))) {
      killGroup(record.pid, "SIGKILL");
      log(`${record.taskId} stopped the orphaned run (pid ${String(record.pid)})`);
    }
    record.outcome = "abandoned";
    record.finishedAt = new Date(now()).toISOString();
    record.note = "the worker stopped while the run was in flight";
    await writeRunRecord(home, record);
  }

  const recovered: Recovered[] = [];
  for (const record of records) {
    if (record.outcome !== "abandoned" || record.reconciledAt !== undefined) continue;
    // A later run of the same task supersedes this one; its own record says
    // what happened to the task.
    const superseded = records.some(
      (other) => other.taskId === record.taskId && other.startedAt > record.startedAt,
    );
    let published: Recovered["published"] = null;
    if (!superseded) {
      try {
        published = await settle(record, options);
      } catch (error) {
        // Left unreconciled on purpose, so the next start tries again.
        log(
          `${record.taskId} could not be settled after an abandoned run: ${describeError(error)}`,
        );
        continue;
      }
    }
    record.reconciledAt = new Date(now()).toISOString();
    await writeRunRecord(home, record);
    recovered.push({
      taskId: record.taskId,
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      published,
    });
    log(
      published === null
        ? `${record.taskId} abandoned run closed; the task needed nothing`
        : `${record.taskId} abandoned run closed; the task was ${published}`,
    );
  }
  return recovered;
}

async function settle(
  record: RunRecord,
  options: RecoveryOptions,
): Promise<"released" | "blocked" | null> {
  const { backend, agentId, onAbandon } = options;
  const detail = await backend.call<TaskDetail>("taskShow", {
    room: record.room,
    taskId: record.taskId,
  });
  const action = abandonAction(detail.task, agentId, onAbandon);
  if (action === null) return null;
  const body =
    action === "released"
      ? `Released by worker ${agentId}: its run was cut off before it finished (the worker stopped). Another machine may take the task.`
      : `Blocked by worker ${agentId}: its run was cut off before it finished (the worker stopped). A person should look before it is run again.`;
  await backend.call("taskUpdate", {
    room: record.room,
    taskId: record.taskId,
    input: { action, body },
  });
  return action;
}
