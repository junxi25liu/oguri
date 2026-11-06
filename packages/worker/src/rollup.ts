/**
 * Close a parent task once its subtasks are done.
 *
 * A planner splits work into subtasks (ADR 0027) and keeps the parent. When the
 * last subtask completes, nothing else moves the parent: its owner has to
 * notice, read every child, and write the summary by hand. This does that step
 * for the parent's owner, and only for it, because only the assignee may
 * complete a task.
 *
 * When a subtask cannot finish on its own — cancelled, or blocked on a person —
 * the parent cannot either. That is said once on the parent, so its creator
 * hears about it there. "Once" is read from the parent's own history, not from
 * a local file, so the worker and `oguri task rollup` never repeat each other.
 */

import { describeError, hasSecrets, type Agenda, type TaskDetail } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { isTerminalTaskState } from "@oguri/protocol";

import { SUMMARY_LIMIT } from "./summary.ts";

/** Every roll-up note starts with this, which is how a later pass finds it. */
export const ROLLUP_NOTE_PREFIX = "Roll-up: subtasks need attention";
const MAX_REFS = 64;
const MAX_TITLE = 120;
const MAX_CHILD_SUMMARY = 160;
const STALLED = new Set<string>(["cancelled", "blocked", "stuck"]);

export interface RollupChild {
  taskId: string;
  title: string;
  state: string;
  /** Blocked or stuck with `needs: human`. */
  needsHuman: boolean;
  /** Refs of the completing event, when the child completed. */
  refs: string[];
  /** First line of the completing event, bounded for the parent's report. */
  summary: string;
}

export interface RollupResult {
  /** `completed`: the parent was completed. `noted`: one note was posted. `none`: nothing to do. */
  action: "completed" | "noted" | "none";
  reason: string;
  children: RollupChild[];
}

export interface RollupOptions {
  log?: (line: string) => void;
}

function title(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1)}…`;
}

function childOf(detail: TaskDetail): RollupChild {
  const last = detail.events.at(-1);
  const completion = [...detail.events].reverse().find((event) => event.action === "completed");
  return {
    taskId: detail.task.id,
    title: detail.task.title,
    state: detail.task.state,
    needsHuman:
      (detail.task.state === "blocked" || detail.task.state === "stuck") && last?.needs === "human",
    refs: detail.task.state === "completed" ? [...(completion?.refs ?? [])] : [],
    summary:
      detail.task.state === "completed"
        ? Array.from(completion?.body.split(/\r?\n/, 1)[0]?.trim() ?? "")
            .slice(0, MAX_CHILD_SUMMARY)
            .join("")
        : "",
  };
}

function line(child: RollupChild): string {
  const refs = child.refs.length === 0 ? "" : ` — ${child.refs.join(", ")}`;
  const summary = child.summary.length === 0 ? "" : ` — ${child.summary}`;
  return `- ${child.taskId} ${title(child.title)}${refs}${summary}`;
}

/** Keep whole child lines, with room to say that the list was cut. */
function bounded(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= SUMMARY_LIMIT) return body;
  const note = "\n\n(roll-up truncated)";
  const head = Buffer.from(body, "utf8")
    .subarray(0, SUMMARY_LIMIT - Buffer.byteLength(note, "utf8"))
    .toString("utf8");
  const newline = head.lastIndexOf("\n");
  return `${newline === -1 ? head.replace(/�+$/, "") : head.slice(0, newline)}${note}`;
}

/**
 * Complete a parent whose children have all completed, or note once on it that
 * a child is cancelled or waiting for a person.
 *
 * Does nothing to a parent this agent does not hold, one that is already
 * finished, or one without children. A parent still `claimed`, `blocked`, or
 * `stuck` is started first, because a task completes only from in progress.
 */
export async function rollupParent(
  backend: Backend,
  agentId: string,
  room: string,
  parentId: string,
  options: RollupOptions = {},
): Promise<RollupResult> {
  const log = options.log ?? (() => undefined);
  const parent = await backend.call<TaskDetail>("taskShow", { room, taskId: parentId });
  const none = (reason: string, children: RollupChild[] = []): RollupResult => ({
    action: "none",
    reason,
    children,
  });
  if (parent.task.assignee !== agentId) {
    return none(`${parentId} is not held by ${agentId}`);
  }
  if (isTerminalTaskState(parent.task.state))
    return none(`${parentId} is already ${parent.task.state}`);
  if (parent.children.length === 0) return none(`${parentId} has no subtasks`);

  const allCompleted = parent.children.every((link) => link.state === "completed");
  // Only these can need a person; a child still at work needs nobody yet. Most
  // passes find exactly that, and it costs one read rather than one per child.
  const stalled = parent.children.filter((link) => STALLED.has(link.state));
  if (!allCompleted && stalled.length === 0) return none("subtasks are still in progress");

  const children: RollupChild[] = [];
  for (const link of allCompleted ? parent.children : stalled) {
    children.push(childOf(await backend.call<TaskDetail>("taskShow", { room, taskId: link.id })));
  }

  const update = async (action: string, body: string, refs: string[] = []): Promise<void> => {
    await backend.call("taskUpdate", {
      room,
      taskId: parentId,
      input: { action, body: bounded(body), ...(refs.length === 0 ? {} : { refs }) },
    });
  };

  if (allCompleted) {
    const refs = [...new Set(children.flatMap((child) => child.refs))].slice(0, MAX_REFS);
    let body = [
      `Roll-up: all ${String(children.length)} subtask(s) completed.`,
      "",
      ...children.map(line),
    ].join("\n");
    // Titles and refs are already in the log, but this message is new, and the
    // scanner refuses rather than warns: a flagged list is not worth losing the
    // completion over.
    if (hasSecrets(body)) {
      body = `Roll-up: all ${String(children.length)} subtask(s) completed. The list was withheld: the secret scanner flagged it.`;
    }
    if (parent.task.state !== "in_progress") {
      await update("started", "All subtasks completed; rolling up.");
    }
    await update("completed", body, hasSecrets(refs.join("\n")) ? [] : refs);
    log(`${parentId} completed: all ${String(children.length)} subtask(s) are done`);
    return { action: "completed", reason: "all subtasks completed", children };
  }

  const attention = children.filter((child) => child.state === "cancelled" || child.needsHuman);
  if (attention.length === 0) {
    return none("blocked subtasks are waiting on their agents, not on a person", children);
  }
  const ids = attention.map((child) => child.taskId);
  const already = parent.events.some(
    (event) =>
      event.from === agentId &&
      event.body.startsWith(ROLLUP_NOTE_PREFIX) &&
      ids.every((id) => event.body.includes(id)),
  );
  if (already) return none("the parent was already told about these subtasks", children);
  // `progressed` needs the parent in progress. A parent someone blocked is
  // already waiting for attention; moving it would undo their decision.
  if (parent.task.state !== "in_progress" && parent.task.state !== "claimed") {
    return none(`${parentId} is ${parent.task.state}; it is already waiting`, children);
  }

  const lines = attention.map(
    (child) =>
      `- ${child.taskId} ${title(child.title)}: ${child.state === "cancelled" ? "cancelled" : `${child.state}, waiting for a person`}`,
  );
  let body = [
    `${ROLLUP_NOTE_PREFIX}. This task cannot complete until they are resolved.`,
    "",
    ...lines,
  ].join("\n");
  if (hasSecrets(body)) {
    body = `${ROLLUP_NOTE_PREFIX}: ${ids.join(", ")}. This task cannot complete until they are resolved.`;
  }
  try {
    await update(parent.task.state === "claimed" ? "started" : "progressed", body);
  } catch (error) {
    throw new Error(`could not post the roll-up note on ${parentId}: ${describeError(error)}`);
  }
  log(`${parentId} noted: ${ids.join(", ")} need attention`);
  return { action: "noted", reason: "subtasks need attention", children };
}

export interface RolledUp {
  room: string;
  taskId: string;
  action: "completed" | "noted";
}

/**
 * Roll up every parent on the agenda that this agent holds.
 *
 * Reads the agenda the pass already has, so a parent whose children are still
 * at work costs nothing. `noted` remembers what this process already looked at
 * and found needing nothing, so a stalled subtask is not re-read every pass.
 * A failure on one parent is logged and the others still run.
 */
export async function rollupAssigned(
  backend: Backend,
  agentId: string,
  agenda: Agenda,
  options: {
    exclude?: ReadonlySet<string>;
    noted?: Set<string>;
    log?: (line: string) => void;
  } = {},
): Promise<RolledUp[]> {
  const log = options.log ?? (() => undefined);
  const rolled: RolledUp[] = [];
  for (const entry of agenda.entries) {
    const { task, children } = entry.status;
    if (entry.relation !== "assigned" || task.assignee !== agentId) continue;
    if (children === undefined || children.length === 0) continue;
    // A parent this worker is running is finished by its own run.
    if (options.exclude?.has(task.id) === true) continue;
    const done = children.every((link) => link.state === "completed");
    const stalled = children.filter((link) => STALLED.has(link.state));
    if (!done && stalled.length === 0) continue;
    const key = `rollup:${task.id}:${children.map((link) => `${link.id}=${link.state}`).join(",")}`;
    if (options.noted?.has(key) === true) continue;
    try {
      const result = await rollupParent(backend, agentId, entry.room, task.id, { log });
      if (result.action === "none") options.noted?.add(key);
      else rolled.push({ room: entry.room, taskId: task.id, action: result.action });
    } catch (error) {
      log(`${task.id} roll-up failed: ${describeError(error)}`);
    }
  }
  return rolled;
}

/**
 * Subtasks of a task that have not completed yet.
 *
 * A run that split its task into subtasks has not finished it. An unreadable
 * task counts as none, so a read failure never holds a completion back.
 */
export async function openChildCount(
  backend: Backend,
  room: string,
  taskId: string,
): Promise<number> {
  try {
    const detail = await backend.call<TaskDetail>("taskShow", { room, taskId });
    return (detail.children ?? []).filter((link) => link.state !== "completed").length;
  } catch {
    return 0;
  }
}
