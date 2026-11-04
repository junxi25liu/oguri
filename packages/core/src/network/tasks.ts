/**
 * Collaborative tasks, as the network performs them.
 *
 * The reducer and the agenda are `../task/tasks.ts` and `../task/agenda.ts`;
 * this is the half that writes a transition into a room and decides who it
 * should reach.
 *
 * Depends on `./approvals.ts` rather than the other way round: claiming is
 * gated, and the gate knows nothing about tasks.
 */

import {
  MENTION_ROOM,
  TASK_TRANSITION_CODES,
  TaskTransitionError,
  assertTaskTransition,
  createTask as createProtocolTask,
  hasTaskAttemptsLeft,
  isTaskCapability,
  taskTargetMachine,
  ulid,
  type Message,
  type Needs,
  type Priority,
  type Task,
  type TaskMandate,
  type TaskOrigin,
  type TaskTransitionCode,
  type TaskUpdateAction,
} from "@oguri/protocol";

import { buildAgenda, type Agenda, type AgendaOptions, type RoomTasks } from "../task/agenda.ts";
import {
  reduceTaskDetail,
  reduceTasks,
  type TaskDetail,
  type TaskHealth,
  type TaskStatus,
} from "../task/tasks.ts";
import type { ApprovalKind } from "../approvals.ts";
import type { SendInput } from "../network.ts";

export interface TaskCreateInput {
  title: string;
  definition: string;
  target?: string;
  staleAfterSeconds?: number;
  priority?: Priority;
  /** Tasks in the same room that must complete before this one may be claimed. */
  dependsOn?: string[];
  /** The task in the same room this one is a subtask of. */
  parent?: string;
  /** Capability names a claimant must declare. */
  requires?: string[];
  /** How many claims the task accepts before it needs its creator. */
  maxAttempts?: number;
  /** The outside conversation the task was requested in (ADR 0030). */
  origin?: TaskOrigin;
  /** Why the task may be done, as the intake policy decided (ADR 0030). */
  mandate?: TaskMandate;
}

export interface TaskUpdateInput {
  action: TaskUpdateAction | "claimed";
  body: string;
  refs?: string[];
  /** New canonical title; valid only for a refinement. */
  title?: string;
  /** New target; null makes an open task free to claim. Valid only for retargeting. */
  target?: string | null;
  /** Allowed only for blocked/stuck when a genuinely critical human decision is required. */
  needsHuman?: boolean;
  /**
   * Valid only for a claim: capability names to assert besides the profile's,
   * such as a worker's `worker.capabilities`. Self-asserted, exactly like the
   * profile entries (ADR 0027).
   */
  capabilities?: readonly string[];
}

/**
 * Agenda options as a surface passes them.
 *
 * `includeCapable: true` means "this agent's own capabilities", read from its
 * profile here, so the CLI, MCP and the worker do not each fetch the profile
 * and filter it the same way.
 */
export type AgendaRequest = Omit<AgendaOptions, "includeCapable"> & {
  includeCapable?: readonly string[] | true;
};

/**
 * One piece of work this session should pick up where the last one left off.
 *
 * The agenda answers "what do I owe"; this answers the narrower question that
 * actually starts a session well — "what was I in the middle of, and what did I
 * leave behind".
 */
export interface ResumePoint {
  room: string;
  taskId: string;
  title: string;
  definition: string;
  health: TaskHealth;
  updatedAt: string;
  /**
   * The last accepted event, which is where the previous session recorded what
   * it had done and what came next. Absent only when the task's thread cannot
   * be read back — a room that failed to open, or history sealed past the live
   * window.
   */
  last?: { action: string; ts: string; from: string; body: string };
}

/** What task orchestration needs from the network. */
export interface TasksContext {
  readonly agentId: string;
  /** This computer, so a task targeted at `machine:<id>` can be claimed here. */
  readonly machineId: string;
  /** Read live: a long-lived process picks up joins and leaves. */
  readonly subscriptions: readonly string[];
  /**
   * This agent's task capabilities: the entries of its published profile that
   * are valid capability names. A claim asserts the ones the task requires.
   */
  capabilities(): Promise<readonly string[]>;
  send(roomId: string, input: SendInput): Promise<Message>;
  read(roomId: string): Promise<Message[]>;
  requireApproval(kind: ApprovalKind, roomId: string, id: string, requester: string): Promise<void>;
}

function taskForAction(
  previous: Task,
  input: TaskUpdateInput,
  author: string,
  authorMachine: string,
  capabilities: readonly string[],
): Task {
  if (input.title !== undefined && input.action !== "refined") {
    throw new TaskTransitionError("only a refinement may provide a new task title");
  }
  if (input.target !== undefined && input.action !== "retargeted") {
    throw new TaskTransitionError("only retargeting may provide a new task target");
  }

  const base: Task = { ...previous, action: input.action };
  switch (input.action) {
    case "refined":
      return { ...base, title: input.title ?? previous.title };
    case "retargeted": {
      if (input.target === undefined) {
        throw new TaskTransitionError(
          "retargeting requires target=<agent> or target=null for free",
        );
      }
      const { target: _target, ...withoutTarget } = base;
      return input.target === null ? withoutTarget : { ...withoutTarget, target: input.target };
    }
    case "claimed": {
      // Stamp the machine the claim was made from when — and only when — the
      // task was aimed at one. That stamp is what every other machine validates
      // the claim against; without it the reducer would have to know the
      // claimer's card, and two readers could disagree.
      const targetMachine = taskTargetMachine(previous.target);
      // Assert only what the task asks for. The event is validated from these
      // alone, and publishing the rest of the profile would add nothing to it.
      const asserted = (previous.requires ?? []).filter((name) => capabilities.includes(name));
      return {
        ...base,
        state: "claimed",
        assignee: author,
        attempt: (previous.attempt ?? 0) + 1,
        ...(targetMachine === null ? {} : { assigneeMachine: authorMachine }),
        ...(asserted.length === 0 ? {} : { claimantCapabilities: asserted }),
      };
    }
    case "started":
    case "progressed":
      return { ...base, state: "in_progress" };
    case "blocked":
      return { ...base, state: "blocked" };
    case "stuck":
      return { ...base, state: "stuck" };
    case "released": {
      const {
        assignee: _assignee,
        assigneeMachine: _machine,
        claimantCapabilities: _capabilities,
        ...withoutAssignee
      } = base;
      return { ...withoutAssignee, state: "open" };
    }
    case "completed":
      return { ...base, state: "completed" };
    case "cancelled":
      return { ...base, state: "cancelled" };
    case "reopened": {
      const {
        assignee: _assignee,
        assigneeMachine: _machine,
        claimantCapabilities: _capabilities,
        ...withoutAssignee
      } = base;
      return { ...withoutAssignee, state: "open" };
    }
  }
}

function taskNeeds(task: Task, needsHuman: boolean): Needs {
  if (needsHuman) return "human";
  return task.state === "open" || task.state === "blocked" || task.state === "stuck"
    ? "agent"
    : "none";
}

function taskMentions(previous: Task, next: Task, author: string): string[] {
  const recipients = new Set<string>();
  const add = (agent: string | undefined): void => {
    if (agent !== undefined && agent !== author) recipients.add(agent);
  };

  add(next.creator);
  if (next.state === "open") {
    recipients.add(next.target ?? MENTION_ROOM);
  } else {
    add(next.target);
    add(next.assignee);
  }
  // A free task was offered to the room. The winning claim is also announced
  // to the room so peers do not duplicate the work before their next list.
  if (next.action === "claimed" && previous.target === undefined) recipients.add(MENTION_ROOM);
  return [...recipients];
}

export async function createTask(
  ctx: TasksContext,
  roomId: string,
  input: TaskCreateInput,
): Promise<Message> {
  if (input.definition.trim().length === 0)
    throw new TypeError("task definition must not be empty");
  const task = createProtocolTask({
    id: ulid(),
    creator: ctx.agentId,
    title: input.title,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.staleAfterSeconds === undefined
      ? {}
      : { staleAfterSeconds: input.staleAfterSeconds }),
    ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    ...(input.requires === undefined ? {} : { requires: input.requires }),
    ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.mandate === undefined ? {} : { mandate: input.mandate }),
  });
  // Graph links are fixed at creation, so a typo would be permanent: a
  // dependency that never exists never completes. Check them against the room
  // before anything is written.
  const linked = [...(task.dependsOn ?? []), ...(task.parent === undefined ? [] : [task.parent])];
  if (linked.length > 0) {
    const known = new Set((await listTasks(ctx, roomId)).map((status) => status.task.id));
    const unknown = linked.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new TypeError(`no task ${unknown.join(", ")} in room ${roomId}`);
    }
  }
  return await ctx.send(roomId, {
    body: input.definition,
    kind: "question",
    needs: "agent",
    mentions: [task.target ?? MENTION_ROOM],
    priority: input.priority ?? "normal",
    tags: ["task", "task-state:open"],
    task,
  });
}

/** Current valid state of every collaborative task in a room. */
export async function listTasks(ctx: TasksContext, roomId: string): Promise<TaskStatus[]> {
  return reduceTasks(await ctx.read(roomId));
}

/**
 * One task with its whole accepted history.
 *
 * This is the resumption path. Long-running work outlives the session that
 * started it — a context window is compacted, a human closes the editor, a
 * released task is picked up by a different agent entirely — and without this
 * the only way back in is to read the room log and filter it by hand, which an
 * agent does badly and expensively. One call returns the definition as it now
 * stands, every accepted event with its evidence, and who has been involved.
 */
export async function showTask(
  ctx: TasksContext,
  roomId: string,
  taskId: string,
): Promise<TaskDetail> {
  const detail = reduceTaskDetail(await ctx.read(roomId), taskId);
  if (detail === undefined) throw new Error(`no task ${taskId} in room ${roomId}`);
  return detail;
}

/**
 * Unfinished work involving this agent, across every subscribed room.
 *
 * Rooms are the unit of subscription, not of attention. `listTasks` takes one
 * room and reports everyone's tasks; this reports one agent's commitments
 * wherever they live, with the ones that have stopped moving first.
 */
export async function agenda(ctx: TasksContext, options: AgendaRequest = {}): Promise<Agenda> {
  const { includeCapable, ...rest } = options;
  const resolved: AgendaOptions =
    includeCapable === undefined
      ? rest
      : {
          ...rest,
          includeCapable: includeCapable === true ? await ctx.capabilities() : includeCapable,
        };
  const rooms: RoomTasks[] = [];
  for (const roomId of ctx.subscriptions) {
    try {
      rooms.push({ room: roomId, tasks: await listTasks(ctx, roomId) });
    } catch {
      // One unreadable room must not hide the commitments in the others.
      continue;
    }
  }
  return buildAgenda(rooms, ctx.agentId, resolved, ctx.machineId);
}

/**
 * What this session was in the middle of, with the last thing it recorded.
 *
 * Long work outlives the session that started it, and a session that opens on
 * somebody else's mail anchors on somebody else's priorities for the rest of its
 * life. The agenda alone would only name the task; the last accepted event is
 * the part that stops the work being redone, so this pays one extra room read
 * per task to carry it.
 *
 * Bounded on purpose: an agent with eleven things in flight has a different
 * problem, and a brief that prints all eleven is one nobody reads.
 */
export async function resume(ctx: TasksContext, limit = 3): Promise<ResumePoint[]> {
  const list = await agenda(ctx, { includeUnclaimed: false });
  const points: ResumePoint[] = [];

  for (const entry of list.entries.filter((e) => e.inFlight).slice(0, Math.max(0, limit))) {
    const task = entry.status.task;
    const last = await showTask(ctx, entry.room, task.id)
      .then((detail) => detail.events.at(-1))
      .catch(() => undefined);
    points.push({
      room: entry.room,
      taskId: task.id,
      title: task.title,
      definition: entry.status.definition,
      health: entry.status.health,
      updatedAt: entry.status.updatedAt,
      ...(last === undefined
        ? {}
        : { last: { action: last.action, ts: last.ts, from: last.from, body: last.body } }),
    });
  }
  return points;
}

/** Claim a task for this agent and publish that assignment to its participants. */
export async function claimTask(
  ctx: TasksContext,
  roomId: string,
  taskId: string,
  body: string,
  capabilities?: readonly string[],
): Promise<Message> {
  return await updateTask(ctx, roomId, taskId, {
    action: "claimed",
    body,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

/**
 * Refuse a claim the task graph forbids, with a code the caller can act on.
 *
 * Runs before the approval gate: asking a person to approve work that cannot
 * be claimed anyway wastes the one interruption the gate exists to protect.
 */
function assertClaimable(status: TaskStatus, capabilities: readonly string[]): void {
  if (status.waitingOn.length > 0) {
    const cancelled = status.waitingOn.filter((link) => link.state === "cancelled");
    throw new TaskTransitionError(
      cancelled.length > 0
        ? `blocked by cancelled dependency ${cancelled.map((link) => link.id).join(", ")}; the creator must decide what happens next`
        : `waiting on ${status.waitingOn.map((link) => `${link.id} (${link.state})`).join(", ")}; claim it once they complete`,
      "DEPENDENCY_PENDING",
    );
  }
  if (!hasTaskAttemptsLeft(status.task)) {
    throw new TaskTransitionError(
      `all ${String(status.task.maxAttempts)} attempt(s) are used; the creator must decide what happens next`,
      "ATTEMPTS_EXHAUSTED",
    );
  }
  const missing = (status.task.requires ?? []).filter((name) => !capabilities.includes(name));
  if (missing.length > 0) {
    throw new TaskTransitionError(
      `this agent does not declare required capabilities: ${missing.join(", ")} (oguri profile update --capability <name>)`,
      "CAPABILITY_MISSING",
    );
  }
}

function transitionCode(code: string | undefined): TaskTransitionCode {
  return (TASK_TRANSITION_CODES as readonly string[]).includes(code ?? "")
    ? (code as TaskTransitionCode)
    : "INVALID_TASK_TRANSITION";
}

/** Append one guarded task refinement, progress update, or lifecycle transition. */
export async function updateTask(
  ctx: TasksContext,
  roomId: string,
  taskId: string,
  input: TaskUpdateInput,
): Promise<Message> {
  if (input.body.trim().length === 0) throw new TypeError("task update must not be empty");
  const status = (await listTasks(ctx, roomId)).find((candidate) => candidate.task.id === taskId);
  if (status === undefined) throw new Error(`no task ${taskId} in room ${roomId}`);

  if (input.capabilities !== undefined) {
    if (input.action !== "claimed") {
      throw new TaskTransitionError("only a claim may assert capabilities");
    }
    if (!Array.isArray(input.capabilities)) {
      throw new TypeError("capabilities must be a list of capability names");
    }
    const invalid = input.capabilities.filter((name) => !isTaskCapability(name));
    if (invalid.length > 0) {
      throw new TypeError(`invalid capability name(s): ${invalid.map(String).join(", ")}`);
    }
  }
  const capabilities =
    input.action === "claimed"
      ? [...new Set([...(await ctx.capabilities()), ...(input.capabilities ?? [])])]
      : [];
  if (input.action === "claimed") {
    if (status.task.state === "open") assertClaimable(status, capabilities);
    await ctx.requireApproval("task", roomId, taskId, status.task.creator);
  }

  const task = taskForAction(status.task, input, ctx.agentId, ctx.machineId, capabilities);
  assertTaskTransition(status.task, task, ctx.agentId);
  if (input.needsHuman === true && task.action !== "blocked" && task.action !== "stuck") {
    throw new TaskTransitionError(
      "needs:human is allowed only for a blocked or stuck task that requires a critical human decision",
    );
  }

  const needs = taskNeeds(task, input.needsHuman === true);
  const mentions = taskMentions(status.task, task, ctx.agentId);
  const message = await ctx.send(roomId, {
    body: input.body,
    kind: "status",
    needs,
    ...(mentions.length === 0 ? {} : { mentions }),
    tags: ["task", `task-state:${task.state}`, `task-action:${task.action}`],
    ...(input.refs === undefined ? {} : { refs: input.refs }),
    inReplyTo: status.currentMessageId,
    thread: status.thread,
    task,
  });

  // A competing claim or stale snapshot remains a permanent, visible event, but
  // must not be reported to the caller as an accepted transition.
  const refreshed = (await listTasks(ctx, roomId)).find(
    (candidate) => candidate.task.id === taskId,
  );
  const rejected = refreshed?.invalidEvents.find((event) => event.messageId === message.header.id);
  if (rejected !== undefined) {
    throw new TaskTransitionError(
      `task update was not accepted: ${rejected.reason}`,
      transitionCode(rejected.code),
    );
  }
  return message;
}
