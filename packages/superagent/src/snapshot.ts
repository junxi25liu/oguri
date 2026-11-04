/**
 * What a superagent sees before it decides (ADR 0031).
 *
 * Everything is read from the transport repository through `Backend`, the same
 * record every agent on every machine reads. A worker is one task's agent
 * session, so the workers are the tasks: who holds each one, on which machine,
 * and how it is doing. The snapshot is also the decision's scope: a room,
 * task, target, or capability that is not in it cannot be named.
 */

import type { MachineRow, TaskStatus } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { machineMention } from "@oguri/protocol";

import type { RouteKind, RouteScope } from "./decision.ts";

export interface SnapshotAgent {
  id: string;
  status: string;
  role: string | null;
  capabilities: string[];
}

export interface SnapshotMachine {
  id: string | null;
  agents: SnapshotAgent[];
}

export interface SnapshotTask {
  id: string;
  room: string;
  title: string;
  state: string;
  health: string;
  creator: string;
  assignee: string | null;
  target: string | null;
  updatedAt: string;
  /** The definition, cut short. */
  definition: string;
  /** This task was started from the conversation being decided on. */
  related: boolean;
  open: boolean;
}

export interface Snapshot {
  rooms: string[];
  machines: SnapshotMachine[];
  tasks: SnapshotTask[];
}

/** Ended tasks stay visible for two days, so "how did it go" can be answered. */
const ENDED_WINDOW_MS = 2 * 24 * 60 * 60_000;
const MAX_TASKS = 40;
const DEFINITION_CHARS = 280;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const OPEN_STATES = new Set(["open", "claimed", "in_progress", "blocked", "stuck"]);

export interface SnapshotOptions {
  rooms: readonly string[];
  /** Tasks started from the conversation being decided on, listed first. */
  related?: ReadonlySet<string>;
  /** Only these agents and machines are shown, for a small superagent that speaks for one machine. */
  only?: { agents: readonly string[]; machine?: string };
  now: number;
}

export async function loadSnapshot(backend: Backend, options: SnapshotOptions): Promise<Snapshot> {
  const machines = await backend.call<MachineRow[]>("machines").catch(() => [] as MachineRow[]);
  const out: SnapshotMachine[] = [];
  for (const machine of machines) {
    const agents: SnapshotAgent[] = [];
    for (const agent of machine.agents) {
      if (options.only !== undefined && !options.only.agents.includes(agent.id)) continue;
      const profile = await backend
        .call<{ capabilities?: string[] } | null>("profileGet", { agent: agent.id })
        .catch(() => null);
      agents.push({
        id: agent.id,
        status: agent.status,
        role: agent.role,
        capabilities: [...(profile?.capabilities ?? [])],
      });
    }
    const machineId =
      options.only?.machine !== undefined && machine.id !== options.only.machine
        ? null
        : machine.id;
    if (agents.length > 0) out.push({ id: machineId, agents });
  }

  const related = options.related ?? new Set<string>();
  const tasks: SnapshotTask[] = [];
  for (const room of options.rooms) {
    const statuses = await backend
      .call<TaskStatus[]>("tasks", { room })
      .catch(() => [] as TaskStatus[]);
    for (const status of statuses) {
      const open = OPEN_STATES.has(status.task.state);
      const age = options.now - Date.parse(status.updatedAt);
      if (!open && !(age <= ENDED_WINDOW_MS)) continue;
      if (
        options.only !== undefined &&
        !options.only.agents.includes(status.task.assignee ?? "") &&
        !options.only.agents.includes(status.task.target ?? "") &&
        status.task.target !==
          (options.only.machine === undefined ? undefined : machineMention(options.only.machine))
      ) {
        continue;
      }
      tasks.push({
        id: status.task.id,
        room,
        title: status.task.title,
        state: status.task.state,
        health: status.health,
        creator: status.task.creator,
        assignee: status.task.assignee ?? null,
        target: status.task.target ?? null,
        updatedAt: status.updatedAt,
        definition: clip(status.definition, DEFINITION_CHARS),
        related: related.has(status.task.id),
        open,
      });
    }
  }
  // This conversation's tasks first, then open before ended, newest first.
  tasks.sort(
    (a, b) =>
      Number(b.related) - Number(a.related) ||
      Number(b.open) - Number(a.open) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  return { rooms: [...options.rooms], machines: out, tasks: tasks.slice(0, MAX_TASKS) };
}

/** The scope a decision is checked against: exactly what the snapshot showed. */
export function scopeOf(
  snapshot: Snapshot,
  options: {
    kinds: readonly RouteKind[];
    mayAnswer: boolean;
    maxSteps: number;
    defaultTarget?: string;
  },
): RouteScope {
  const targets = new Set<string>();
  const capabilities = new Set<string>();
  for (const machine of snapshot.machines) {
    if (machine.id !== null) targets.add(machineMention(machine.id));
    for (const agent of machine.agents) {
      targets.add(agent.id);
      for (const capability of agent.capabilities) capabilities.add(capability);
    }
  }
  return {
    kinds: options.kinds,
    rooms: snapshot.rooms,
    targets: [...targets],
    capabilities: [...capabilities],
    tasks: snapshot.tasks.map((task) => ({ id: task.id, open: task.open })),
    mayAnswer: options.mayAnswer,
    maxSteps: options.maxSteps,
    ...(options.defaultTarget === undefined ? {} : { defaultTarget: options.defaultTarget }),
  };
}

export function renderSnapshot(snapshot: Snapshot): string {
  const lines: string[] = ["Machines and their agents (status: live, stale, or away):"];
  if (snapshot.machines.length === 0) lines.push("  (none known yet)");
  for (const machine of snapshot.machines) {
    lines.push(machine.id === null ? "  agents:" : `  machine:${machine.id}`);
    for (const agent of machine.agents) {
      const parts = [`    - ${agent.id} [${agent.status}]`];
      if (agent.capabilities.length > 0)
        parts.push(`capabilities: ${agent.capabilities.join(", ")}`);
      if (agent.role !== null) parts.push(`role: ${agent.role}`);
      lines.push(parts.join(" · "));
    }
  }
  lines.push(
    "",
    `Rooms tasks may be created in: ${snapshot.rooms.join(", ")}`,
    "",
    "Workers (one per task; the assignee's machine runs it):",
  );
  if (snapshot.tasks.length === 0) lines.push("  (none)");
  for (const task of snapshot.tasks) {
    const who =
      task.assignee !== null
        ? `held by ${task.assignee}`
        : task.target === null
          ? "waiting for any worker"
          : `waiting for ${task.target}`;
    lines.push(
      `  - ${task.id} [${task.state}, ${task.health}] ${task.title} · ${who}` +
        `${task.related ? " · from this conversation" : ""} · updated ${task.updatedAt}`,
    );
    lines.push(`      ${task.definition}`);
  }
  return lines.join("\n");
}
