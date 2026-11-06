/**
 * What a worker's run may write, whichever surface it writes through (ADR 0036).
 *
 * Every run on a machine shares that machine's agent identity, so "the assignee
 * is me" cannot tell one run from another: the protocol would let a run update
 * any task any other run holds. The run's own task, from `OGURI_TASK_ID`, is the
 * only thing that can. So a process started for a run gets its backend through
 * this gate, and the MCP server and the CLI inherit one rule.
 *
 * Anything not known to be a read counts as a write, so a method added later is
 * gated until someone says otherwise. This is a guard against a run steered by
 * text it read, not a sandbox: like `--as-human`, it holds for a process that
 * goes through oguri's own surfaces, and a shell that unsets the variable leaves.
 */

import {
  DEFAULT_WORKER_POLICY,
  describeError,
  type ResolvedPolicy,
  type TaskStatus,
} from "@oguri/core";

import type { Method } from "../protocol.ts";
import type { Backend, NetworkSummary } from "./types.ts";

/** How far up a parent chain the gate walks. A longer chain is refused, never trusted. */
export const MAX_PARENT_HOPS = 8;

/** At most one fetch per this long, so a 50-step plan does not fetch 50 times. */
const SYNC_EVERY_MS = 5_000;

const READ_METHODS: ReadonlySet<Method> = new Set<Method>([
  "ping",
  "status",
  "sync",
  "rooms",
  "roomShow",
  "reviews",
  "tasks",
  "claims",
  "taskShow",
  "agenda",
  "resume",
  "policy",
  "approvals",
  "read",
  "history",
  "search",
  "decisions",
  "inbox",
  "health",
  "outbox",
  "surroundings",
  "networks",
  "trace",
  "forecastDelivery",
  "agents",
  "machines",
  "peers",
  "profileGet",
  "presence",
  "receipts",
  "mentions",
  "waitInbox",
  "sealCheck",
  "sessionClose",
]);

/**
 * What belongs to whoever asked for the task, not to the run doing it. The
 * definition's header picks the runner and tier, so a run that could rewrite it
 * could pick its own next run's model. The worker's own tier climb is the
 * worker's process, not a run, and does not pass through here.
 */
const REQUESTER_ACTIONS: ReadonlySet<string> = new Set(["refined", "retargeted", "relinked"]);

const HANDBACK_HINT = "use oguri_task action=ask, or action=handback to return the work";

/** A write this run may not make. Policy, not a fault: do not retry it another way. */
export class RunScopeError extends Error {
  readonly code = "RUN_SCOPE";

  constructor(message: string) {
    super(`refused inside a worker's run: ${message}`);
    this.name = "RunScopeError";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The run this process was started for, or null when it was not started for one. */
export function runOf(
  env: NodeJS.ProcessEnv = process.env,
): { taskId: string; room: string | undefined } | null {
  const taskId = nonEmpty(env["OGURI_TASK_ID"]);
  return taskId === undefined ? null : { taskId, room: nonEmpty(env["OGURI_TASK_ROOM"]) };
}

/**
 * How many parents `taskId` has, or null when the chain cannot be established:
 * a parent the room does not carry, or more than `MAX_PARENT_HOPS` of them.
 */
export function taskDepth(statuses: readonly TaskStatus[], taskId: string): number | null {
  const byId = new Map(statuses.map((status) => [status.task.id, status.task]));
  let at = byId.get(taskId);
  if (at === undefined) return null;
  for (let hops = 0; hops <= MAX_PARENT_HOPS; hops += 1) {
    if (at.parent === undefined) return hops;
    at = byId.get(at.parent);
    if (at === undefined) return null;
  }
  return null;
}

/** Whether `taskId` is a subtask of `root`, at any depth the gate is willing to walk. */
export function isDescendant(
  statuses: readonly TaskStatus[],
  taskId: string,
  root: string,
): boolean {
  const byId = new Map(statuses.map((status) => [status.task.id, status.task]));
  let at = byId.get(taskId);
  for (let hops = 0; hops < MAX_PARENT_HOPS && at?.parent !== undefined; hops += 1) {
    if (at.parent === root) return true;
    at = byId.get(at.parent);
  }
  return false;
}

/** The checks, for the callers that write around `Backend.call`. */
export class RunScope {
  readonly taskId: string;
  readonly room: string | undefined;
  private readonly inner: Backend;
  /** A follow-up that answers on a task that stays completed (ADR 0030 §5). */
  private readonly replyOnly: boolean;
  private agent: string | undefined;
  private syncedAt = Number.NEGATIVE_INFINITY;

  constructor(inner: Backend, taskId: string, room: string | undefined, replyOnly: boolean) {
    this.inner = inner;
    this.taskId = taskId;
    this.room = room;
    this.replyOnly = replyOnly;
  }

  /** The room's tasks as they are now, once the run's own task has passed. */
  private async live(reply = false): Promise<{ statuses: TaskStatus[]; current: TaskStatus }> {
    const { taskId, room } = this;
    if (room === undefined) {
      throw new RunScopeError(`task ${taskId} has no room: OGURI_TASK_ROOM is unset`);
    }
    if (this.inner.mode === "direct" && Date.now() - this.syncedAt >= SYNC_EVERY_MS) {
      // Over a daemon its own sync loop keeps this fresh. A failed fetch leaves
      // the last known state, which is what the rest of oguri reads too.
      await this.inner.call("sync").catch(() => undefined);
      this.syncedAt = Date.now();
    }
    let statuses: TaskStatus[];
    try {
      statuses = await this.inner.call<TaskStatus[]>("tasks", { room });
      this.agent ??= (await this.inner.call<{ agentId: string }>("status")).agentId;
    } catch (error) {
      throw new RunScopeError(`task ${taskId} could not be read: ${describeError(error)}`);
    }
    const current = statuses.find((status) => status.task.id === taskId);
    if (current === undefined) throw new RunScopeError(`there is no task ${taskId} in ${room}`);
    const { state, assignee } = current.task;
    if (state === "cancelled") {
      throw new RunScopeError(`task ${taskId} was cancelled, so this run has nothing left to do`);
    }
    if (state === "completed" && !(reply && this.replyOnly && assignee === this.agent)) {
      throw new RunScopeError(`task ${taskId} is already completed`);
    }
    if (assignee !== this.agent) {
      throw new RunScopeError(
        assignee === undefined
          ? `task ${taskId} was released, so it no longer belongs to this run`
          : `task ${taskId} was reassigned to ${assignee}`,
      );
    }
    return { statuses, current };
  }

  private inRoom(room: unknown): void {
    if (room !== this.room) {
      throw new RunScopeError(
        `task writes stay in this run's room ${String(this.room)}, not ${String(room)}; ${HANDBACK_HINT}`,
      );
    }
  }

  /** A write that names no task: refused only once the run's task has ended. */
  async assertLive(): Promise<void> {
    await this.live();
  }

  /** A message. It may answer on a reply-only follow-up, but cannot carry a task event. */
  async assertSend(input: { task?: unknown } | undefined): Promise<void> {
    if (input?.task !== undefined) {
      throw new RunScopeError("a task event goes through a task update, never a plain send");
    }
    await this.live(true);
  }

  /** A new subtask: always under this run's task, and within `worker.maxTaskDepth`. */
  async assertCreate(room: unknown, parent: unknown): Promise<void> {
    const { statuses } = await this.live();
    this.inRoom(room);
    if (parent !== undefined && parent !== this.taskId) {
      throw new RunScopeError(
        `a subtask created here is a subtask of ${this.taskId}, not of ${String(parent)}; ${HANDBACK_HINT}`,
      );
    }
    const limit = await this.maxTaskDepth();
    const depth = taskDepth(statuses, this.taskId);
    if (depth === null) {
      throw new RunScopeError(
        `the parents of task ${this.taskId} cannot be followed within ${String(MAX_PARENT_HOPS)} steps, so its depth is unknown; ${HANDBACK_HINT}`,
      );
    }
    if (depth + 1 > limit) {
      throw new RunScopeError(
        `a subtask here would be at depth ${String(depth + 1)}, past worker.maxTaskDepth (${String(limit)}); do the work in this run, or use oguri_task action=handback`,
      );
    }
  }

  /** An update or a claim: only this run's task and its subtasks. */
  async assertUpdate(room: unknown, taskId: unknown, action: unknown): Promise<void> {
    const { statuses, current } = await this.live();
    this.inRoom(room);
    if (taskId !== this.taskId) {
      if (typeof taskId !== "string" || !isDescendant(statuses, taskId, this.taskId)) {
        throw new RunScopeError(
          `task ${String(taskId)} is neither this run's task (${this.taskId}) nor one of its subtasks; ${HANDBACK_HINT}`,
        );
      }
      return;
    }
    if (typeof action === "string" && REQUESTER_ACTIONS.has(action)) {
      throw new RunScopeError(
        `'${action}' on this run's own task is its requester's to make; ${HANDBACK_HINT}`,
      );
    }
    if (action === "completed") {
      const open = (current.children ?? []).filter((link) => link.state !== "completed");
      if (open.length > 0) {
        throw new RunScopeError(
          `task ${this.taskId} still has ${String(open.length)} open subtask(s); end the run with result.json and the roll-up completes it when they do`,
        );
      }
    }
  }

  /** A runner request (ADR 0034 grants): it may ask only about this run's own work. */
  async assertRequest(input: { taskId?: string | undefined; room?: string | undefined }) {
    const { statuses } = await this.live();
    if (input.room !== undefined) this.inRoom(input.room);
    const { taskId } = input;
    if (
      taskId !== undefined &&
      taskId !== this.taskId &&
      !isDescendant(statuses, taskId, this.taskId)
    ) {
      throw new RunScopeError(
        `a runner request from this run may name only its own task (${this.taskId}) or a subtask, not ${taskId}`,
      );
    }
  }

  private async maxTaskDepth(): Promise<number> {
    let limit: number | undefined;
    try {
      const resolved = await this.inner.call<ResolvedPolicy>("policy");
      limit = resolved.policy.worker.maxTaskDepth;
    } catch (error) {
      throw new RunScopeError(
        `worker.maxTaskDepth could not be read, so no subtask is created: ${describeError(error)}`,
      );
    }
    // A daemon started before the key existed answers without it: the default
    // applies, never "no limit".
    return typeof limit === "number" ? limit : DEFAULT_WORKER_POLICY.maxTaskDepth;
  }
}

/** A backend whose writes pass the gate first. Reads pass straight through. */
export class RunScopedBackend implements Backend {
  readonly runScope: RunScope;
  private readonly inner: Backend;

  constructor(
    inner: Backend,
    run: { taskId: string; room: string | undefined },
    replyOnly: boolean,
  ) {
    this.inner = inner;
    this.runScope = new RunScope(inner, run.taskId, run.room, replyOnly);
  }

  get mode(): Backend["mode"] {
    return this.inner.mode;
  }

  async call<T = unknown>(
    method: Method,
    params: Record<string, unknown> = {},
    network?: string,
  ): Promise<T> {
    if (READ_METHODS.has(method)) return await this.inner.call<T>(method, params, network);
    if (network !== undefined) {
      throw new RunScopeError(`'${method}' on another network is out of this run's reach`);
    }
    return await this.inner.call<T>(method, await this.check(method, params));
  }

  /** The params to send, once the write is allowed. */
  private async check(
    method: Method,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const scope = this.runScope;
    const input = params["input"] as Record<string, unknown> | undefined;
    switch (method) {
      case "approve":
      case "approveRevoke":
        throw new RunScopeError("approving work is the person's, at this machine's terminal");
      case "profileUpdate":
        throw new RunScopeError(
          "a run shares its agent's identity and does not describe it; report progress on your task instead",
        );
      case "taskCreate":
        await scope.assertCreate(params["room"], input?.["parent"]);
        return { ...params, input: { ...input, parent: scope.taskId } };
      case "taskClaim":
        await scope.assertUpdate(params["room"], params["taskId"], "claimed");
        return params;
      case "taskUpdate":
        await scope.assertUpdate(params["room"], params["taskId"], input?.["action"]);
        return params;
      case "send":
        await scope.assertSend(input);
        return params;
      default:
        await scope.assertLive();
        return params;
    }
  }

  async networks(): Promise<NetworkSummary[]> {
    return await this.inner.networks();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/** The backend a process should use: gated when it was started for a run. */
export function scopeToRun(backend: Backend, env: NodeJS.ProcessEnv = process.env): Backend {
  const run = runOf(env);
  if (run === null) return backend;
  return new RunScopedBackend(backend, run, env["OGURI_TASK_REPLY_ONLY"] === "1");
}
