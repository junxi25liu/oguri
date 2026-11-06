/**
 * What a superagent sees before it decides (ADR 0031).
 *
 * Everything is read from the transport repository through `Backend`, the same
 * record every agent on every machine reads. A worker is one task's agent
 * session, so the workers are the tasks: who holds each one, on which machine,
 * and how it is doing. The snapshot is also the decision's scope: a room,
 * task, target, or capability that is not in it cannot be named.
 */

import {
  allowListGate,
  runnerAvailability,
  type MachineRow,
  type RunnerGate,
  type TaskStatus,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { machineMention } from "@oguri/protocol";

import type { RouteKind, RouteScope, ScopeRunner, ScopeTier } from "./decision.ts";

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
  /** Tasks it waits for, all of them. */
  dependsOn: string[];
  /** Dependencies that were cancelled: it will never become claimable until Big acts. */
  cancelledDependencies: string[];
}

export interface Snapshot {
  rooms: string[];
  machines: SnapshotMachine[];
  tasks: SnapshotTask[];
  /** The runner tiers a worker may be deployed on (ADR 0034); set by `decide`. */
  choices?: { tiers: ScopeTier[]; runners: ScopeRunner[] };
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
    // A cancelled task that an open one still waits on stays visible however
    // old: it is the thing the decision has to name.
    const blocking = new Set(
      statuses
        .filter((status) => OPEN_STATES.has(status.task.state))
        .flatMap((status) =>
          (status.waitingOn ?? [])
            .filter((link) => link.state === "cancelled")
            .map((link) => link.id),
        ),
    );
    for (const status of statuses) {
      const open = OPEN_STATES.has(status.task.state);
      const age = options.now - Date.parse(status.updatedAt);
      if (!open && !(age <= ENDED_WINDOW_MS) && !blocking.has(status.task.id)) continue;
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
        dependsOn: [...(status.task.dependsOn ?? [])],
        cancelledDependencies:
          status.task.state === "open"
            ? (status.waitingOn ?? [])
                .filter((link) => link.state === "cancelled")
                .map((link) => link.id)
            : [],
      });
    }
  }
  // This conversation's tasks first, then tasks stuck behind a cancelled
  // dependency, then open before ended, newest first.
  const stalled = (task: SnapshotTask): number =>
    Number(task.cancelledDependencies.length > 0) +
    Number(tasks.some((other) => other.cancelledDependencies.includes(task.id)));
  tasks.sort(
    (a, b) =>
      Number(b.related) - Number(a.related) ||
      stalled(b) - stalled(a) ||
      Number(b.open) - Number(a.open) ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  return { rooms: [...options.rooms], machines: out, tasks: tasks.slice(0, MAX_TASKS) };
}

/**
 * The tiers and runners a decision may name (ADR 0034), from this machine's
 * own policy and gate.
 *
 * With tiers configured, only runners in a tier are offered: the others are
 * the superagents' own thinkers or the owner's special cases, and a worker
 * should not land on them by accident. A runner the gate refuses is left
 * out, so the router is never shown a choice that cannot run.
 */
export function tierScope(
  worker: Pick<WorkerPolicy, "runners" | "tiers">,
  gate: RunnerGate = allowListGate,
): { tiers: ScopeTier[]; runners: ScopeRunner[] } {
  const usable = (name: string): boolean => runnerAvailability(worker, name, gate).ok;
  const names =
    worker.tiers.length === 0
      ? Object.keys(worker.runners)
      : [...new Set(worker.tiers.flatMap((tier) => tier.runners))];
  const runners: ScopeRunner[] = names.filter(usable).map((name) => {
    const runner = worker.runners[name];
    return {
      name,
      ...(runner?.model === undefined ? {} : { model: runner.model }),
      efforts: [...(runner?.efforts ?? [])],
    };
  });
  const tiers: ScopeTier[] = worker.tiers.map((tier) => ({
    name: tier.name,
    runners: tier.runners.filter(usable),
    ...(tier.effort === undefined ? {} : { effort: tier.effort }),
  }));
  return { tiers, runners };
}

/** The tiers as the router reads them: cheapest first, with each runner's model. */
export function renderTiers(scope: {
  tiers: readonly ScopeTier[];
  runners: readonly ScopeRunner[];
}): string {
  const describe = (name: string): string => {
    const runner = scope.runners.find((r) => r.name === name);
    if (runner === undefined) return name;
    const parts = [
      ...(runner.model === undefined ? [] : [runner.model]),
      ...(runner.efforts.length === 0 ? [] : [`efforts ${runner.efforts.join("/")}`]),
    ];
    return parts.length === 0 ? name : `${name} (${parts.join("; ")})`;
  };
  if (scope.tiers.length === 0) {
    return `Runners a worker may use (no tiers are configured): ${scope.runners.map((r) => describe(r.name)).join(", ") || "(none)"}`;
  }
  return [
    "Runner tiers on this machine, cheapest first:",
    ...scope.tiers.map(
      (tier, index) =>
        `  ${String(index + 1)}. ${tier.name}: ${tier.runners.length === 0 ? "(no runner may run here now)" : tier.runners.map(describe).join(", ")}${tier.effort === undefined ? "" : ` · default effort ${tier.effort}`}`,
    ),
  ].join("\n");
}

/** The scope a decision is checked against: exactly what the snapshot showed. */
export function scopeOf(
  snapshot: Snapshot,
  options: {
    kinds: readonly RouteKind[];
    mayAnswer: boolean;
    maxSteps: number;
    defaultTarget?: string;
    tiers?: { tiers: readonly ScopeTier[]; runners: readonly ScopeRunner[] };
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
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      open: task.open,
      state: task.state,
      dependsOn: task.dependsOn,
    })),
    mayAnswer: options.mayAnswer,
    maxSteps: options.maxSteps,
    ...(options.defaultTarget === undefined ? {} : { defaultTarget: options.defaultTarget }),
    ...(options.tiers === undefined
      ? {}
      : { tiers: options.tiers.tiers, runners: options.tiers.runners }),
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
    if (task.dependsOn.length > 0) {
      lines.push(`      depends on: ${task.dependsOn.join(", ")}`);
    }
    if (task.cancelledDependencies.length > 0) {
      lines.push(
        `      STUCK: waiting on cancelled ${task.cancelledDependencies.join(", ")}; it cannot start until you relink, replace, or stop it`,
      );
    }
    lines.push(`      ${task.definition}`);
  }
  if (snapshot.choices !== undefined) lines.push("", renderTiers(snapshot.choices));
  return lines.join("\n");
}
