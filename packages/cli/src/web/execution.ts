/**
 * Pure read-only aggregation for the execution-centre dashboard.
 *
 * `data.ts` performs the reads; this module only folds their results. Nothing
 * here touches git, the filesystem or the backend, so every state — blocked,
 * unknown, missing cost, a second machine, a failed read — can be exercised
 * with a fixture. A fact that is not on the wire stays `null` (unknown):
 * notably there is no remote cost telemetry, and a policy saying `enabled` is
 * never presented as proof that a process is running.
 */

import type { AgendaCounts, MachineAgentRow, MachineRow, PresenceRow } from "@oguri/core";
import { reportStuck, type RunRecord } from "@oguri/worker";

import type { HumanItem, MessageView, RoomView, TaskView } from "./data.ts";
import { sortNeedsYou, type NeedsYouItem } from "./needs-you.ts";

export type Confidence = "observed" | "reported" | "unknown";
export type DashboardMode = "daemon" | "direct";
export type DashboardView = "overview" | "machines" | "tasks" | "runs";

export interface OverviewCounts {
  machines: number | null;
  agents: number | null;
  liveAgents: number | null;
  /** Counts below cover subscribed rooms, not the whole transport. */
  running: number | null;
  queued: number | null;
  blocked: number | null;
  completed: number | null;
  networkTasks: number | null;
  /** Tasks per lifecycle state, so the page can show the whole hierarchy at once. */
  stateCounts: Record<string, number> | null;
  needsYou: number | null;
  needsHuman: number | null;
  /** This agent's agenda, not a network-wide tally. */
  agenda: AgendaCounts | null;
}

export interface SyncView {
  lastSyncAt: string | null;
  ageSeconds: number | null;
  degraded: boolean | null;
  reason: string | null;
  confidence: Confidence;
}

export interface AlertItem {
  level: "critical" | "warning" | "info";
  text: string;
  view: DashboardView;
}

export interface SuperagentObservation {
  /** A tagged network message is a report, never a process heartbeat. */
  role: "big" | "small" | "unknown";
  lastMessageAt: string;
  lastMessageId: string;
  note: "message observed; process state unknown";
}

export interface AgentView {
  id: string;
  status: string;
  confidence: Confidence;
  lastSeen: string | null;
  lastActivity: string | null;
  sessions: number | null;
  tool: string | null;
  role: string | null;
  focus: string | null;
  workspace: string | null;
  capabilities: string[];
  superagent: SuperagentObservation | null;
}

export interface MachinePolicyView {
  /** True only when this machine's own policy was read successfully. */
  known: boolean;
  workerEnabled: boolean | null;
  bigEnabled: boolean | null;
  smallEnabled: boolean | null;
  runners: string[];
  /** Effective concurrency, with Small's override when enabled. */
  concurrency: number | null;
  concurrencySource: string | null;
  workerConcurrency: number | null;
  /** `superagent.small.maxWorkers`: runs the small superagent may start here. */
  maxWorkers: number | null;
  maxPerHour: number | null;
  /** The hourly cap counts runs; it is not a dollar budget. */
  maxPerHourLabel: "runs/hour";
}

export interface MachineView {
  id: string | null;
  label: string | null;
  self: boolean;
  contested: boolean;
  humans: string[];
  live: number | null;
  agents: AgentView[];
  /** Tasks whose recorded assignee machine or target names this machine. */
  tasks: TaskView[];
  /** Local run records exist only for `self`; never invented for a remote. */
  localRuns: RunRecord[] | null;
  policy: MachinePolicyView | null;
}

export interface TaskDetailView extends TaskView {
  room: string;
  /** The latest message of this task, when it is in the room window. */
  currentMessage: MessageView | null;
  /** Messages in the task's thread, newest first (bounded by the room window). */
  threadMessages: MessageView[];
  needsYou: NeedsYouItem[];
  /** Local run records for this task; remote runs are not visible here. */
  runs: RunRecord[];
  /** The runner recorded by a local run, or null when unknown. */
  runner: string | null;
  /** Machine from an assignee machine or a machine target. */
  machine: string | null;
  machineConfidence: Confidence;
  roomError: string | null;
}

export interface ActivityItem {
  id: string;
  room: string;
  from: string;
  ts: string;
  kind: string;
  needs: string;
  taskId: string | null;
  excerpt: string;
}

export interface LocalExecution {
  /** Records in the current local window, not a network-wide total. */
  runs: number;
  running: number;
  completed: number;
  failed: number;
  /** Runs started on this machine's local calendar day. */
  todayRuns: number;
  /**
   * The **known subtotal** of today's priced runs, or null when none reported
   * a price. Null is not zero.
   */
  todayCostUsd: number | null;
  /** Today's runs `todayCostUsd` does not cover; null when that is not known. */
  todayUnpricedRuns: number | null;
  /**
   * True only when every run today is inside the figure: a complete total, as
   * opposed to a partial one. False when completeness is unknown.
   */
  costComplete: boolean;
  costAvailable: boolean;
  costSource: "local run logs" | null;
  maxPerHour: number | null;
  /** Effective concurrency: Small's maxWorkers while enabled, worker.concurrency otherwise. */
  maxConcurrent: number | null;
  concurrencySource: string | null;
  /** Raw worker.concurrency, retained to explain the Small override. */
  workerConcurrency: number | null;
  /**
   * `superagent.small.maxWorkers`: how many workers the small superagent may
   * start on this machine. Shown beside concurrency so the two are not read
   * as the same limit.
   */
  smallMaxWorkers: number | null;
  runners: string[];
  scope: "this machine only";
}

export interface LocalPolicyFacts {
  workerEnabled?: boolean;
  bigEnabled?: boolean;
  smallEnabled?: boolean;
  runners?: string[];
  /** Effective runs at once, resolved by the machine-local caller. */
  concurrency?: number;
  concurrencySource?: "worker.concurrency" | "superagent.small.maxWorkers";
  workerConcurrency?: number;
  /** `superagent.small.maxWorkers`: workers the small superagent may start. */
  maxWorkers?: number;
  maxPerHour?: number;
}

export interface LocalUsageFacts {
  date?: string;
  runs?: number;
  costUsd?: number | null;
  /** Runs outside the subtotal; absent on older callers, which then say unknown. */
  unpricedRuns?: number;
}

export interface Overview {
  generatedAt: string;
  network: string | null;
  agent: string | null;
  mode: DashboardMode;
  remote: string | null;
  sync: SyncView;
  daemon: {
    observed: boolean;
    sessions: number | null;
    sessionLive: boolean | null;
    loopRunning: boolean | null;
    cadence: string | null;
  };
  counts: OverviewCounts;
  local: LocalExecution;
  alerts: AlertItem[];
}

export interface ExecutionCenter {
  overview: Overview;
  /** Null when the machines read failed: unknown, not an empty team. */
  machines: MachineView[] | null;
  tasks: TaskDetailView[];
  activity: ActivityItem[];
  needsYou: NeedsYouItem[];
  needsHuman: HumanItem[];
  runs: RunRecord[];
  /** One failed read never erases the rest of the page. */
  errors: string[];
  /** Legacy keys keep `/api/dashboard`'s read-only contract intact. */
  status: Record<string, unknown> | null;
  presence: PresenceRow[];
  agenda: {
    counts: AgendaCounts;
    entries: { room: string; relation: string; needsAttention: boolean; task: TaskView }[];
  } | null;
  rooms: RoomView[];
  readMethods: readonly string[];
  /** Legacy top-level keys; `/api/dashboard` has always answered these. */
  generatedAt?: string;
  mode?: DashboardMode;
  agent?: string | null;
  network?: string | null;
}

/** Everything `data.ts` read, already sanitised where needed. */
export interface ExecutionInput {
  generatedAt: string;
  mode: DashboardMode;
  now: number;
  status: Record<string, unknown> | null;
  machines: MachineRow[] | null;
  presence: PresenceRow[] | null;
  agenda: { counts: AgendaCounts } | null;
  rooms: readonly RoomView[];
  runs: readonly RunRecord[];
  /** Already mapped by `data.ts`, so this fold needs no core types. */
  needsHuman: readonly HumanItem[];
  agendaEntries: { room: string; relation: string; needsAttention: boolean; task: TaskView }[];
  /** All optional: machine-local only, absent on older callers. */
  policy?: LocalPolicyFacts | null;
  usage?: LocalUsageFacts | null;
  errors: readonly string[];
  readMethods: readonly string[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function isRunning(state: string): boolean {
  return state === "claimed" || state === "in_progress";
}

/** `machine:<id>` is the protocol's machine target; anything else is opaque. */
export function machineOfTask(task: TaskView): string | null {
  if (task.assigneeMachine !== null) return task.assigneeMachine;
  return task.target !== null && task.target.startsWith("machine:")
    ? task.target.slice("machine:".length)
    : null;
}

const SUPERAGENT_TAGS = ["from-superagent", "superagent-small", "to-big", "to-small"] as const;

/** A tagged message says who spoke, not that the superagent's process is live. */
export function superagentObservation(
  agentId: string,
  messages: readonly MessageView[],
): SuperagentObservation | null {
  let latest: MessageView | null = null;
  let role: "big" | "small" | "unknown" = "unknown";
  for (const message of messages) {
    const tags = message.tags ?? [];
    if (message.from !== agentId || !SUPERAGENT_TAGS.some((tag) => tags.includes(tag))) continue;
    if (latest === null || message.ts.localeCompare(latest.ts) >= 0) {
      latest = message;
      role = tags.includes("to-small")
        ? "big"
        : tags.includes("superagent-small")
          ? "small"
          : "unknown";
    }
  }
  return latest === null
    ? null
    : {
        role,
        lastMessageAt: latest.ts,
        lastMessageId: latest.id,
        note: "message observed; process state unknown",
      };
}

function agentView(
  agent: MachineAgentRow,
  presence: readonly PresenceRow[],
  messages: readonly MessageView[],
): AgentView {
  const row = presence.find((p) => p.id === agent.id);
  // Presence is derived from an observed card/activity, or a live daemon
  // session for this agent; it is never inferred from a policy flag.
  const status = text(row?.status) ?? text(agent.status) ?? "unknown";
  return {
    id: agent.id,
    status,
    confidence: status === "unknown" ? "unknown" : "observed",
    lastSeen: text(agent.lastSeen) ?? text(row?.lastSeen) ?? null,
    lastActivity: text(agent.lastActivity) ?? text(row?.lastActivity) ?? null,
    sessions: number(agent.sessions) ?? number(row?.sessions) ?? null,
    tool: text(agent.tool) ?? text(row?.tool) ?? null,
    role: text(agent.role),
    focus: text(agent.focus),
    workspace: text(agent.workspace),
    capabilities: strings(agent.capabilities),
    superagent: superagentObservation(agent.id, messages),
  };
}

export function taskDetail(
  room: RoomView,
  task: TaskView,
  needs: readonly NeedsYouItem[],
  runs: readonly RunRecord[],
): TaskDetailView {
  const ownRuns = runs.filter((run) => run.taskId === task.id);
  const children = [
    ...new Set([
      ...task.children,
      ...room.tasks.filter((other) => other.parent === task.id).map((other) => other.id),
    ]),
  ];
  const machine = machineOfTask(task);
  return {
    ...task,
    children,
    room: room.room,
    currentMessage:
      task.currentMessageId === null
        ? null
        : (room.messages.find((message) => message.id === task.currentMessageId) ?? null),
    threadMessages: room.messages.filter(
      (message) => message.thread === task.thread || message.taskId === task.id,
    ),
    needsYou: needs.filter((item) => item.taskId === task.id),
    runs: ownRuns,
    runner: ownRuns.find((run) => typeof run.runner === "string")?.runner ?? null,
    machine,
    machineConfidence: machine === null ? "unknown" : "reported",
    roomError: text(room.error),
  };
}

export function activityFrom(rooms: readonly RoomView[], limit = 40): ActivityItem[] {
  const items = rooms.flatMap((room) =>
    room.messages.map((message) => ({
      id: message.id,
      room: room.room,
      from: message.from,
      ts: message.ts,
      kind: message.kind,
      needs: message.needs,
      taskId: message.taskId,
      excerpt: message.excerpt,
    })),
  );
  return items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
}

function taskCounts(
  tasks: readonly TaskView[],
): Pick<
  OverviewCounts,
  "running" | "queued" | "blocked" | "completed" | "networkTasks" | "stateCounts"
> {
  const stateCounts: Record<string, number> = {};
  for (const task of tasks) stateCounts[task.state] = (stateCounts[task.state] ?? 0) + 1;
  return {
    running: tasks.filter((task) => isRunning(task.state)).length,
    queued: tasks.filter((task) => task.state === "open").length,
    blocked: tasks.filter((task) => task.state === "blocked" || task.state === "stuck").length,
    completed: tasks.filter((task) => task.state === "completed").length,
    networkTasks: tasks.length,
    stateCounts,
  };
}

export function syncView(
  status: Record<string, unknown> | null,
  now: number,
  mode: DashboardMode,
): SyncView {
  const health = object(status?.["health"]);
  const daemon = object(status?.["daemon"]);
  const loopSync = number(daemon?.["lastLoopSyncAt"]);
  const lastSyncAt =
    text(health?.["lastSyncAt"]) ??
    text(status?.["lastSyncAt"]) ??
    (loopSync === null ? null : new Date(loopSync).toISOString());
  const parsed = lastSyncAt === null ? Number.NaN : Date.parse(lastSyncAt);
  const age =
    number(health?.["ageSeconds"]) ??
    (Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 1000)) : null);
  const degraded =
    bool(health?.["degraded"]) ??
    // In direct mode an old local sync is an observation, not a failure.
    (mode === "daemon" && age !== null ? age > 300 : null);
  return {
    lastSyncAt,
    ageSeconds: age,
    degraded,
    reason: text(health?.["reason"]),
    confidence: health !== null ? "observed" : lastSyncAt !== null ? "reported" : "unknown",
  };
}

function localDay(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export function localExecution(
  runs: readonly RunRecord[],
  usage: LocalUsageFacts | null,
  policy: LocalPolicyFacts | null,
  now: number,
): LocalExecution {
  const day = localDay(new Date(now).toISOString());
  const startedToday = runs.filter((run) => localDay(run.startedAt) === day).length;
  const cost = usage === null ? null : number(usage.costUsd);
  const todayRuns = (usage === null ? null : number(usage.runs)) ?? startedToday;
  // An older caller that does not report the gap cannot show a complete total:
  // unknown is not zero, and it is certainly not "everything is priced".
  const unpriced = usage === null ? null : number(usage.unpricedRuns);
  return {
    runs: runs.length,
    running: runs.filter((run) => run.outcome === "running").length,
    completed: runs.filter((run) => run.outcome === "completed" || run.outcome === "answered")
      .length,
    failed: runs.filter((run) =>
      ["blocked", "released", "unreported", "abandoned", "failed"].includes(run.outcome),
    ).length,
    todayRuns,
    // A missing price stays null; the page says "unknown", never "$0.00".
    todayCostUsd: cost,
    todayUnpricedRuns: unpriced,
    costComplete: cost !== null && unpriced === 0,
    costAvailable: cost !== null,
    costSource: cost !== null ? "local run logs" : null,
    maxPerHour: policy === null ? null : number(policy.maxPerHour),
    maxConcurrent: policy === null ? null : number(policy.concurrency),
    concurrencySource: policy?.concurrencySource ?? null,
    workerConcurrency: policy === null ? null : number(policy.workerConcurrency),
    smallMaxWorkers: policy === null ? null : number(policy.maxWorkers),
    runners: policy === null ? [] : strings(policy.runners),
    scope: "this machine only",
  };
}

export function policyView(policy: LocalPolicyFacts | null): MachinePolicyView {
  return {
    known: policy !== null,
    workerEnabled: policy === null ? null : (bool(policy.workerEnabled) ?? null),
    bigEnabled: policy === null ? null : (bool(policy.bigEnabled) ?? null),
    smallEnabled: policy === null ? null : (bool(policy.smallEnabled) ?? null),
    runners: policy === null ? [] : strings(policy.runners),
    concurrency: policy === null ? null : number(policy.concurrency),
    concurrencySource: policy?.concurrencySource ?? null,
    workerConcurrency: policy === null ? null : number(policy.workerConcurrency),
    maxWorkers: policy === null ? null : number(policy.maxWorkers),
    maxPerHour: policy === null ? null : number(policy.maxPerHour),
    maxPerHourLabel: "runs/hour",
  };
}

export function alerts(
  counts: OverviewCounts,
  sync: SyncView,
  errors: readonly string[],
  machines: readonly MachineView[],
  rooms: readonly RoomView[],
  runs: readonly RunRecord[] = [],
): AlertItem[] {
  const items: AlertItem[] = [];
  const stuck = runs.filter(reportStuck).length;
  if (stuck > 0) {
    items.push({
      level: "critical",
      text: `${String(stuck)} finished run(s) could not report their result to the task after repeated retries; the worker keeps trying (oguri worker status).`,
      view: "overview",
    });
  }
  if (sync.degraded === true) {
    items.push({
      level: "critical",
      text:
        sync.reason === null
          ? "Transport sync is degraded; data may be stale."
          : `Sync degraded: ${sync.reason}`,
      view: "overview",
    });
  }
  const people = (counts.needsYou ?? 0) + (counts.needsHuman ?? 0);
  if (people > 0) {
    items.push({
      level: "critical",
      text: `${String(people)} item(s) need a person.`,
      view: "overview",
    });
  }
  if ((counts.blocked ?? 0) > 0) {
    items.push({
      level: "warning",
      text: `${String(counts.blocked)} blocked or stuck task(s) in subscribed rooms.`,
      view: "tasks",
    });
  }
  if (machines.some((machine) => machine.contested)) {
    items.push({
      level: "warning",
      text: "A machine id is claimed by more than one person; routing may be ambiguous.",
      view: "machines",
    });
  }
  if (rooms.some((room) => room.error !== undefined)) {
    items.push({
      level: "warning",
      text: "Some rooms could not be read; their tasks may be missing.",
      view: "tasks",
    });
  }
  for (const error of errors.slice(0, 3)) {
    items.push({ level: "info", text: error, view: "overview" });
  }
  return items;
}

/** Fold the reads into the page's one response. No I/O, no writes. */
export function buildExecutionCenter(input: ExecutionInput): ExecutionCenter {
  const needs = sortNeedsYou(input.rooms.flatMap((room) => room.needsYou));
  const humanItems = [...input.needsHuman];
  const flatTasks = input.rooms.flatMap((room) => room.tasks.map((task) => ({ room, task })));
  const tasks = flatTasks.map(({ room, task }) => taskDetail(room, task, needs, input.runs));
  const allMessages = input.rooms.flatMap((room) => room.messages);
  const machines: MachineView[] | null =
    input.machines === null
      ? null
      : input.machines.map((machine) => {
          const id = text(machine.id);
          return {
            id,
            label: text(machine.label) ?? id,
            self: machine.self === true,
            contested: machine.contested === true,
            humans: strings(machine.humans),
            live: number(machine.live),
            agents: machine.agents.map((agent) =>
              agentView(agent, input.presence ?? [], allMessages),
            ),
            tasks: tasks.filter((task) => task.machine !== null && task.machine === id),
            // Remote run telemetry is never invented.
            localRuns: machine.self ? [...input.runs] : null,
            // Remote policy is never guessed; only this machine's own is read.
            policy: machine.self ? policyView(input.policy ?? null) : null,
          };
        });
  const counts: OverviewCounts = {
    machines: machines === null ? null : machines.length,
    agents:
      machines === null ? null : machines.reduce((sum, machine) => sum + machine.agents.length, 0),
    liveAgents:
      machines === null ? null : machines.reduce((sum, machine) => sum + (machine.live ?? 0), 0),
    ...taskCounts(flatTasks.map(({ task }) => task)),
    needsYou: needs.length,
    needsHuman: humanItems.length,
    agenda: input.agenda === null ? null : input.agenda.counts,
  };
  const daemon = object(input.status?.["daemon"]);
  const local = localExecution(input.runs, input.usage ?? null, input.policy ?? null, input.now);
  const sync = syncView(input.status, input.now, input.mode);
  const view: ExecutionCenter = {
    overview: {
      generatedAt: input.generatedAt,
      network: text(input.status?.["networkId"]),
      agent: text(input.status?.["agentId"]),
      mode: input.mode,
      remote: text(input.status?.["remote"]),
      sync,
      daemon: {
        observed: daemon !== null,
        sessions: number(daemon?.["sessions"]),
        sessionLive: bool(daemon?.["sessionLive"]),
        loopRunning: bool(daemon?.["loopRunning"]),
        cadence: text(daemon?.["cadence"]),
      },
      counts,
      local,
      alerts: alerts(counts, sync, input.errors, machines ?? [], input.rooms, input.runs),
    },
    machines,
    tasks,
    activity: activityFrom(input.rooms),
    needsYou: needs,
    needsHuman: humanItems,
    runs: [...input.runs],
    errors: [...input.errors],
    status: input.status,
    presence: input.presence ?? [],
    agenda:
      input.agenda === null
        ? null
        : {
            counts: input.agenda.counts,
            entries: [...input.agendaEntries],
          },
    rooms: [...input.rooms],
    readMethods: input.readMethods,
  };
  // `/api/dashboard` keeps its original keys as well as the new view.
  return {
    ...view,
    generatedAt: view.overview.generatedAt,
    mode: view.overview.mode,
    agent: view.overview.agent,
    network: view.overview.network,
  };
}
