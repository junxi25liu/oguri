/**
 * Rendering for the task graph: dependencies, subtasks, requirements, attempts.
 *
 * Kept apart from `output.ts` because `task list`, `task show`, `task agenda`
 * and `task tree` all describe the same few facts, and they should read the
 * same everywhere.
 */

import type { TaskLink, TaskStatus } from "@oguri/core";
import { bold, cyan, dim, green, out, red, yellow } from "./output.ts";

/** "3/5 subtasks done", or null for a task with no subtasks. */
export function childProgress(status: TaskStatus): string | null {
  if (status.children.length === 0) return null;
  const done = status.children.filter((child) => child.state === "completed").length;
  return `${String(done)}/${String(status.children.length)} subtasks done`;
}

/** "attempt 2/3", "attempt 1", or null before the first claim of an unbounded task. */
export function attemptLabel(status: TaskStatus): string | null {
  const attempt = status.task.attempt ?? 0;
  if (status.task.maxAttempts !== undefined) {
    return `attempt ${String(attempt)}/${String(status.task.maxAttempts)}`;
  }
  return attempt === 0 ? null : `attempt ${String(attempt)}`;
}

/**
 * Why an open task cannot be claimed now, or null when it can (or is not open).
 *
 * A cancelled dependency is named first because it is the one that will not
 * resolve by waiting.
 */
export function readinessLabel(status: TaskStatus): string | null {
  if (status.task.state !== "open" || status.ready) return null;
  const cancelled = status.waitingOn.filter((link) => link.state === "cancelled");
  if (cancelled.length > 0) return `blocked by cancelled ${links(cancelled)}`;
  if (status.waitingOn.length > 0) return `waiting on ${links(status.waitingOn)}`;
  return "attempts exhausted";
}

function links(list: readonly TaskLink[]): string {
  return list.map((link) => `${link.id.slice(-8)} (${link.state})`).join(", ");
}

/** One-line graph facts for `task list` and `task agenda`, empty when there are none. */
export function graphSummary(status: TaskStatus): string {
  const parts: string[] = [];
  const readiness = readinessLabel(status);
  if (readiness !== null) parts.push(yellow(readiness));
  else if (status.task.state === "open" && (status.task.dependsOn ?? []).length > 0) {
    parts.push(green("ready"));
  }
  const progress = childProgress(status);
  if (progress !== null) parts.push(progress);
  if ((status.task.requires ?? []).length > 0) {
    parts.push(`requires ${(status.task.requires ?? []).join(", ")}`);
  }
  const attempt = attemptLabel(status);
  if (attempt !== null) parts.push(attempt);
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

/** The graph section of `task show`. Prints nothing for a task with no graph facts. */
export function renderGraphDetail(status: TaskStatus): void {
  const task = status.task;
  const lines: string[] = [];
  if (task.parent !== undefined) lines.push(`parent     ${task.parent}`);
  if ((task.dependsOn ?? []).length > 0) {
    const waiting = new Map(status.waitingOn.map((link) => [link.id, link.state]));
    lines.push(
      `depends on ${(task.dependsOn ?? [])
        .map((id) => `${id} (${waiting.get(id) ?? "completed"})`)
        .join(", ")}`,
    );
  }
  const readiness = readinessLabel(status);
  if (task.state === "open") lines.push(`ready      ${readiness === null ? "yes" : readiness}`);
  if ((task.requires ?? []).length > 0) {
    lines.push(`requires   ${(task.requires ?? []).join(", ")}`);
  }
  const attempt = attemptLabel(status);
  if (attempt !== null) lines.push(`attempts   ${attempt.slice("attempt ".length)}`);
  const progress = childProgress(status);
  if (progress !== null) {
    lines.push(`subtasks   ${progress}`);
    for (const child of status.children) lines.push(`  ${child.id} (${child.state})`);
  }
  if (lines.length === 0) return;
  out();
  out(bold("graph"));
  for (const line of lines) out(`  ${line}`);
}

/** One node of `task tree --json`. */
export interface TaskTreeNode {
  id: string;
  title: string;
  state: string;
  ready: boolean;
  dependsOn: string[];
  waitingOn: TaskLink[];
  requires: string[];
  children: TaskTreeNode[];
}

/**
 * Arrange a room's tasks by parent.
 *
 * A task whose parent the room does not carry is a root, so a partial view
 * still renders every task. The visited set guards against a cycle that a
 * hand-written log could contain: oguri itself only links to tasks that
 * already exist, so it cannot create one.
 */
export function buildTaskTree(tasks: readonly TaskStatus[], rootId?: string): TaskTreeNode[] {
  const byId = new Map(tasks.map((status) => [status.task.id, status]));
  // Oldest first, so siblings read in creation order; ULIDs sort by time.
  const ordered = [...tasks].sort((a, b) => a.task.id.localeCompare(b.task.id));
  const visited = new Set<string>();

  const node = (status: TaskStatus): TaskTreeNode => {
    visited.add(status.task.id);
    const children = ordered.filter(
      (candidate) => candidate.task.parent === status.task.id && !visited.has(candidate.task.id),
    );
    return {
      id: status.task.id,
      title: status.task.title,
      state: status.task.state,
      ready: status.ready,
      dependsOn: [...(status.task.dependsOn ?? [])],
      waitingOn: status.waitingOn,
      requires: [...(status.task.requires ?? [])],
      children: children.map(node),
    };
  };

  if (rootId !== undefined) {
    const root = byId.get(rootId);
    return root === undefined ? [] : [node(root)];
  }
  const roots = ordered.filter(
    (status) => status.task.parent === undefined || !byId.has(status.task.parent),
  );
  const tree = roots.map(node);
  // Anything left is on a parent cycle; show it rather than lose it.
  for (const status of ordered) if (!visited.has(status.task.id)) tree.push(node(status));
  return tree;
}

function stateBadge(state: string): string {
  if (state === "completed") return green(state);
  if (state === "cancelled") return dim(state);
  if (state === "blocked" || state === "stuck") return red(state);
  return cyan(state);
}

/** Print a task tree with box-drawing branches and dependency edges under each node. */
export function renderTaskTree(nodes: readonly TaskTreeNode[]): void {
  const walk = (node: TaskTreeNode, prefix: string, branch: string, last: boolean): void => {
    const marks: string[] = [];
    if (node.state === "open") {
      marks.push(node.ready ? green("ready") : yellow("not ready"));
    }
    if (node.requires.length > 0) marks.push(`requires ${node.requires.join(", ")}`);
    out(
      `${prefix}${branch}${bold(node.id)} ${stateBadge(node.state)} ${node.title}` +
        (marks.length === 0 ? "" : dim(` · ${marks.join(" · ")}`)),
    );
    const inner = prefix + (branch === "" ? "" : last ? "   " : "│  ");
    const waiting = new Map(node.waitingOn.map((link) => [link.id, link.state]));
    for (const dependency of node.dependsOn) {
      const state = waiting.get(dependency) ?? "completed";
      out(dim(`${inner}${node.children.length > 0 ? "│" : " "}  ⇠ needs ${dependency} (${state})`));
    }
    node.children.forEach((child, index) => {
      const lastChild = index === node.children.length - 1;
      walk(child, inner, lastChild ? "└─ " : "├─ ", lastChild);
    });
  };
  for (const node of nodes) walk(node, "", "", true);
}
