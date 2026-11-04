import {
  MENTION_ROOM,
  assertDependenciesMet,
  assertInitialTask,
  assertTaskTransition,
  compareMessages,
  hasTaskAttemptsLeft,
  isTerminalTaskState,
  nextTaskAttempt,
  type AuthorKind,
  type Message,
  type Needs,
  type Task,
  type TaskAction,
  type TaskState,
} from "@oguri/protocol";
import { describeError } from "../errors.ts";

export type TaskHealth = "active" | "stale" | "blocked" | "stuck" | "done";

export interface InvalidTaskEvent {
  messageId: string;
  reason: string;
  /** The refusal code when the rule that refused it has one, e.g. `DEPENDENCY_PENDING`. */
  code?: string;
}

/**
 * Another task in the same room, as this one sees it.
 *
 * `missing` means the room does not carry that task: not yet fetched, never
 * created, or sealed out of the live window.
 */
export interface TaskLink {
  id: string;
  state: TaskState | "missing";
}

export interface TaskStatus {
  task: Task;
  rootMessageId: string;
  currentMessageId: string;
  definitionMessageId: string;
  thread: string;
  definition: string;
  updatedAt: string;
  staleAt: string;
  stale: boolean;
  health: TaskHealth;
  invalidEvents: InvalidTaskEvent[];
  /**
   * Dependencies that are not `completed` yet, with the state each is in.
   *
   * A `cancelled` entry will never complete on its own; such a task also
   * reports health `blocked`, so its creator sees that it has to act.
   */
  waitingOn: TaskLink[];
  /** Open, every dependency completed, and a claim left under `maxAttempts`. */
  ready: boolean;
  /** Tasks in this room whose `parent` is this one, oldest first. */
  children: TaskLink[];
}

/**
 * One accepted event, rendered for a reader rather than for the state machine.
 *
 * Carries the body, because the body is where the work actually is: what was
 * tried, what it produced, what comes next. `TaskStatus` deliberately omits
 * these — a room with fifty tasks would otherwise ship fifty transcripts to
 * anyone who asked which tasks exist.
 */
export interface TaskEventView {
  messageId: string;
  ts: string;
  from: string;
  authorKind: AuthorKind;
  action: TaskAction;
  state: TaskState;
  needs: Needs;
  body: string;
  refs: string[];
}

/**
 * A task with its full accepted history.
 *
 * This is what makes long-running work resumable. An agent that lost its
 * context — a new session, a compacted conversation, or a peer taking over a
 * released task — can reconstruct the whole engagement from one call instead of
 * reading the room log and filtering it by hand.
 */
export interface TaskDetail extends TaskStatus {
  events: TaskEventView[];
  /** Every agent that authored an accepted event, in first-appearance order. */
  participants: string[];
}

function assertInitialEvent(message: Message): void {
  const task = message.header.task;
  if (task === undefined) throw new Error("message has no task snapshot");
  if (message.header.kind !== "question") {
    throw new Error("the initial task event must have kind 'question'");
  }
  if (message.header.thread !== message.header.id || message.header.inReplyTo !== undefined) {
    throw new Error("the initial task event must be the thread root");
  }
  if (message.header.needs !== "agent") {
    throw new Error("the initial task event must have needs 'agent'");
  }
  const destination = task.target ?? MENTION_ROOM;
  if (!message.header.mentions.includes(destination)) {
    throw new Error(`the initial task event must mention ${destination}`);
  }
  assertInitialTask(task, message.header.from);
}

function assertUpdateEvent(message: Message, acceptedIds: ReadonlySet<string>): void {
  const task = message.header.task;
  if (task === undefined) throw new Error("message has no task snapshot");
  if (message.header.kind !== "status") {
    throw new Error("task updates must have kind 'status'");
  }
  if (message.header.inReplyTo === undefined || !acceptedIds.has(message.header.inReplyTo)) {
    throw new Error("task updates must reply to an accepted event in the task thread");
  }

  if (message.header.needs === "human") {
    if (task.state !== "blocked" && task.state !== "stuck") {
      throw new Error("only a blocked or stuck task may request a human decision");
    }
    return;
  }
  const expectedNeeds =
    task.state === "open" || task.state === "blocked" || task.state === "stuck" ? "agent" : "none";
  if (message.header.needs !== expectedNeeds) {
    throw new Error(`task state '${task.state}' must have needs '${expectedNeeds}'`);
  }
}

function healthFor(task: Task, stale: boolean, waitingOn: readonly TaskLink[]): TaskHealth {
  if (isTerminalTaskState(task.state)) return "done";
  if (task.state === "blocked") return "blocked";
  if (task.state === "stuck") return "stuck";
  // A cancelled dependency never completes by itself, so an open task behind
  // one cannot move until its creator drops the dependency's work or reopens it.
  if (task.state === "open" && waitingOn.some((link) => link.state === "cancelled")) {
    return "blocked";
  }
  return stale ? "stale" : "active";
}

interface ReducedTask {
  status: TaskStatus;
  /** Accepted events in protocol order, root first. */
  accepted: Message[];
}

/** One task while the room is being reduced. */
interface Reduction {
  root: Message;
  current: Message;
  /** The accepted snapshot with the derived attempt count, whatever the event carried. */
  task: Task;
  definition: string;
  definitionMessageId: string;
  accepted: Message[];
  acceptedIds: Set<string>;
  invalidEvents: InvalidTaskEvent[];
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "INVALID_TASK_TRANSITION" ? code : undefined;
}

function invalid(event: Message, error: unknown): InvalidTaskEvent {
  const code = errorCode(error);
  return {
    messageId: event.header.id,
    reason: describeError(error),
    ...(code === undefined ? {} : { code }),
  };
}

/** The snapshot as the reducer holds it: `attempt` derived, zero written as absent. */
function withAttempt(task: Task, attempt: number): Task {
  const { attempt: _carried, ...rest } = task;
  return attempt === 0 ? rest : { ...rest, attempt };
}

/**
 * Reduce every task in a room together, in one pass over canonical order.
 *
 * One pass rather than one task at a time, because a claim's validity depends
 * on other tasks: it is accepted only if every dependency had already
 * completed at that point in the room's order. Asking the dependency's *final*
 * state instead would make the verdict depend on what a reader had fetched
 * when it looked, and two machines could disagree about who owns the work.
 *
 * Events may branch so several agents can refine a task concurrently; they are
 * applied in ULID order, and a transition that loses a race is reported under
 * `invalidEvents` instead of silently overwriting an assignee.
 */
function reduceRoom(messages: readonly Message[], now: number): Map<string, ReducedTask> {
  const events = messages
    .filter((message) => message.header.task !== undefined)
    .sort((a, b) => compareMessages(a.header, b.header));
  const reductions = new Map<string, Reduction>();
  // Events seen before a task's root are kept and attached once a root is
  // accepted; a task that never gets one is not reported at all.
  const orphans = new Map<string, InvalidTaskEvent[]>();

  for (const event of events) {
    const next = event.header.task as Task;
    const reduction = reductions.get(next.id);
    if (reduction === undefined) {
      try {
        assertInitialEvent(event);
        reductions.set(next.id, {
          root: event,
          current: event,
          task: withAttempt(next, 0),
          definition: event.body,
          definitionMessageId: event.header.id,
          accepted: [event],
          acceptedIds: new Set([event.header.id]),
          invalidEvents: orphans.get(next.id) ?? [],
        });
        orphans.delete(next.id);
      } catch (error) {
        const bucket = orphans.get(next.id);
        if (bucket === undefined) orphans.set(next.id, [invalid(event, error)]);
        else bucket.push(invalid(event, error));
      }
      continue;
    }

    try {
      if (event.header.thread !== reduction.root.header.thread) {
        throw new Error("task events must stay in the task's root thread");
      }
      assertUpdateEvent(event, reduction.acceptedIds);
      assertTaskTransition(reduction.task, next, event.header.from);
      if (next.action === "claimed") {
        assertDependenciesMet(reduction.task, (id) => reductions.get(id)?.task.state);
      }
      reduction.task = withAttempt(next, nextTaskAttempt(reduction.task, next));
      reduction.current = event;
      reduction.accepted.push(event);
      reduction.acceptedIds.add(event.header.id);
      if (next.action === "refined") {
        reduction.definition = event.body;
        reduction.definitionMessageId = event.header.id;
      }
    } catch (error) {
      reduction.invalidEvents.push(invalid(event, error));
    }
  }

  const stateOf = (id: string): TaskState | "missing" =>
    reductions.get(id)?.task.state ?? "missing";
  const children = new Map<string, TaskLink[]>();
  for (const [id, reduction] of reductions) {
    const parent = reduction.task.parent;
    if (parent === undefined) continue;
    const bucket = children.get(parent);
    const link: TaskLink = { id, state: reduction.task.state };
    if (bucket === undefined) children.set(parent, [link]);
    else bucket.push(link);
  }

  const reduced = new Map<string, ReducedTask>();
  for (const [id, reduction] of reductions) {
    const { task, current } = reduction;
    const waitingOn: TaskLink[] = isTerminalTaskState(task.state)
      ? []
      : (task.dependsOn ?? [])
          .map((dependency) => ({ id: dependency, state: stateOf(dependency) }))
          .filter((link) => link.state !== "completed");
    const staleAtMs = Date.parse(current.header.ts) + task.staleAfterSeconds * 1000;
    const stale = !isTerminalTaskState(task.state) && now >= staleAtMs;
    reduced.set(id, {
      accepted: reduction.accepted,
      status: {
        task,
        rootMessageId: reduction.root.header.id,
        currentMessageId: current.header.id,
        definitionMessageId: reduction.definitionMessageId,
        thread: reduction.root.header.thread,
        definition: reduction.definition,
        updatedAt: current.header.ts,
        staleAt: new Date(staleAtMs).toISOString(),
        stale,
        health: healthFor(task, stale, waitingOn),
        invalidEvents: reduction.invalidEvents,
        waitingOn,
        ready: task.state === "open" && waitingOn.length === 0 && hasTaskAttemptsLeft(task),
        // Reductions are keyed in root order, so children come out oldest first.
        children: children.get(id) ?? [],
      },
    });
  }
  return reduced;
}

function toEventView(message: Message): TaskEventView {
  const task = message.header.task as Task;
  return {
    messageId: message.header.id,
    ts: message.header.ts,
    from: message.header.from,
    authorKind: message.header.authorKind,
    action: task.action,
    state: task.state,
    needs: message.header.needs,
    body: message.body,
    refs: [...message.header.refs],
  };
}

/** Derive current task state from immutable events. */
export function reduceTasks(messages: readonly Message[], now = Date.now()): TaskStatus[] {
  const statuses = [...reduceRoom(messages, now).values()].map((reduced) => reduced.status);
  return statuses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Reduce one task and keep the narrative: definition, every accepted event with
 * its body and refs, and who took part.
 *
 * Reduces the whole room, because whether a claim was accepted depends on the
 * other tasks this one depends on.
 */
export function reduceTaskDetail(
  messages: readonly Message[],
  taskId: string,
  now = Date.now(),
): TaskDetail | undefined {
  const reduced = reduceRoom(messages, now).get(taskId);
  if (reduced === undefined) return undefined;

  const participants: string[] = [];
  for (const event of reduced.accepted) {
    if (!participants.includes(event.header.from)) participants.push(event.header.from);
  }
  return {
    ...reduced.status,
    events: reduced.accepted.map(toEventView),
    participants,
  };
}

/**
 * Threads that carry a task which has not reached a terminal state.
 *
 * Used to keep the room reply budget from parking work in progress. The budget
 * exists to stop two agents ping-ponging forever with nothing to show; a task
 * thread already has a stronger bound, because it must reach `completed` or
 * `cancelled` and its silence deadline surfaces it if it does not.
 *
 * Pass the whole room: a task with dependencies reduces correctly only beside
 * the tasks it depends on.
 */
export function activeTaskThreads(messages: readonly Message[], now = Date.now()): Set<string> {
  const threads = new Set<string>();
  for (const { status } of reduceRoom(messages, now).values()) {
    if (!isTerminalTaskState(status.task.state)) threads.add(status.thread);
  }
  return threads;
}
