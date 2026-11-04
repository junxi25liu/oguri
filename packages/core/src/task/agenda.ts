import { isTerminalTaskState, taskTargetMachine } from "@oguri/protocol";

import type { TaskStatus } from "./tasks.ts";

/** Why a task is on one agent's agenda. */
export const AGENDA_RELATIONS = ["assigned", "offered", "capable", "created", "unclaimed"] as const;
export type AgendaRelation = (typeof AGENDA_RELATIONS)[number];

export interface AgendaEntry {
  room: string;
  relation: AgendaRelation;
  /**
   * True when this agent owns the task and it is still moving: the work in
   * hand, as opposed to work merely owed. Mutually exclusive with
   * `needsAttention` — a task has either not stopped or it has.
   */
  inFlight: boolean;
  /** True when this entry is stale, blocked, or stuck — i.e. it is not moving. */
  needsAttention: boolean;
  /**
   * True when this agent could claim the task now: it is open, every
   * dependency has completed, it has an attempt left, and — when it names
   * required capabilities — every one is in `includeCapable`.
   *
   * An `offered` entry that is not ready is reported so the work stays
   * visible, but nothing should claim it: the claim would be refused.
   */
  ready: boolean;
  status: TaskStatus;
}

export interface AgendaCounts {
  assigned: number;
  offered: number;
  capable: number;
  created: number;
  unclaimed: number;
  stale: number;
  blocked: number;
  stuck: number;
  /** Tasks this agent owns and is actively moving. */
  inFlight: number;
  /** Entries this agent owns or created that have stopped moving. */
  needsAttention: number;
}

export interface Agenda {
  entries: AgendaEntry[];
  counts: AgendaCounts;
  /**
   * Threads of every in-flight task, whatever `limit` and `includeUnclaimed`
   * do to `entries`.
   *
   * This is what lets a caller decide whether an arriving message bears on the
   * work in hand without opening a single message body — see
   * `classifyAttention`. It is derived from the whole agenda, like the counts,
   * because a truncated list would silently narrow what counts as relevant.
   */
  inFlightThreads: string[];
}

export interface AgendaOptions {
  /**
   * List open tasks nobody has claimed.
   *
   * Defaults to true only while this agent has nothing in flight. Free work is
   * an offer worth making to an idle agent and a distraction to a busy one: an
   * agent three hours into a refactor does not need every unclaimed task in
   * every room ranked beside it, and the check-in that was meant to re-anchor
   * it on its own work becomes the thing that pulls it away.
   *
   * Setting it explicitly overrides that. An explicit `false` also drops
   * unclaimed work from the counts, which is what `--mine` asks for, while the
   * automatic suppression keeps counting it — the offer stays visible as a
   * number without being ranked into the list.
   */
  includeUnclaimed?: boolean;
  /** Cap the returned entries. Counts always describe the whole agenda. */
  limit?: number;
  /**
   * This agent's capabilities. When given, a free task whose `requires` this
   * agent satisfies is listed as `capable` — work addressed by what an agent
   * can do rather than by who it is — whatever `includeUnclaimed` says. It
   * also decides `ready` for any task that names requirements; without it,
   * such a task is never ready, because nothing says this agent qualifies.
   *
   * A free task without `requires` is unaffected and stays `unclaimed`.
   */
  includeCapable?: readonly string[];
}

export interface RoomTasks {
  room: string;
  tasks: readonly TaskStatus[];
}

/**
 * Decide how one task relates to one agent, or that it does not.
 *
 * Order matters: an agent that created a task and then claimed it is working on
 * it, so `assigned` wins. A creator's own task that someone else owns still
 * shows up, because the creator is who chases it when it stops moving.
 */
function relationFor(
  status: TaskStatus,
  agentId: string,
  machineId: string | undefined,
  capable: boolean,
): AgendaRelation | null {
  const task = status.task;
  if (isTerminalTaskState(task.state)) return null;
  if (task.assignee === agentId) return "assigned";
  // Work aimed at this computer is offered to every agent on it. Ranking it as
  // `offered` rather than `unclaimed` is the point: it was addressed here on
  // purpose, so it outranks the room's free backlog and is not suppressed while
  // a peer on the same box is busy.
  const targetMachine = taskTargetMachine(task.target);
  if (
    task.state === "open" &&
    (task.target === agentId || (targetMachine !== null && targetMachine === machineId))
  ) {
    return "offered";
  }
  // The creator keeps `created` even when it could do the work itself: chasing
  // its own task when it stalls is the creator's job, and `capable` entries do
  // not count as attention.
  if (task.creator === agentId) return "created";
  if (task.state === "open" && task.target === undefined && capable) return "capable";
  if (task.state === "open" && task.target === undefined) return "unclaimed";
  return null;
}

const RELATION_ORDER: Record<AgendaRelation, number> = {
  assigned: 0,
  offered: 1,
  capable: 2,
  created: 3,
  unclaimed: 4,
};

/** Whether `capabilities` covers every requirement; unknown capabilities cover none. */
function satisfies(status: TaskStatus, capabilities: readonly string[] | undefined): boolean {
  const requires = status.task.requires ?? [];
  if (requires.length === 0) return true;
  return capabilities !== undefined && requires.every((name) => capabilities.includes(name));
}

/**
 * Build one agent's cross-room view of unfinished collaborative work.
 *
 * Rooms are the unit of subscription, not of attention: an agent carrying work
 * in five rooms has no way to see it as one commitment from `task list`, which
 * takes a room and reports everyone's tasks. This reduces the same events into
 * "what am I on the hook for, and what has stopped moving".
 *
 * Pure, so the ordering and the counting are testable without git.
 */
export function buildAgenda(
  rooms: readonly RoomTasks[],
  agentId: string,
  options: AgendaOptions = {},
  machineId?: string,
): Agenda {
  const owned: AgendaEntry[] = [];
  const unclaimed: AgendaEntry[] = [];

  for (const { room, tasks } of rooms) {
    for (const status of tasks) {
      const qualified = satisfies(status, options.includeCapable);
      // `capable` is only for work that asks for capabilities: a plain free
      // task is the room's backlog, and keeps today's `unclaimed` treatment.
      const capable =
        options.includeCapable !== undefined &&
        (status.task.requires ?? []).length > 0 &&
        qualified;
      const relation = relationFor(status, agentId, machineId, capable);
      if (relation === null) continue;
      // Free work nobody owns is an offer, not a neglected commitment;
      // counting it as attention would make every idle backlog look on fire.
      const offer = relation === "unclaimed" || relation === "capable";
      const needsAttention = !offer && status.health !== "active";
      const inFlight = relation === "assigned" && status.health === "active";
      const ready = status.ready && qualified;
      const entry: AgendaEntry = { room, relation, inFlight, needsAttention, ready, status };
      if (relation === "unclaimed") unclaimed.push(entry);
      else owned.push(entry);
    }
  }

  const inFlightThreads = owned.filter((e) => e.inFlight).map((e) => e.status.thread);
  // Two separate questions, deliberately: whether to rank free work into a busy
  // agent's list, and whether to admit that it exists at all.
  const listUnclaimed = options.includeUnclaimed ?? inFlightThreads.length === 0;
  const countUnclaimed = options.includeUnclaimed !== false;

  const entries = listUnclaimed ? [...owned, ...unclaimed] : [...owned];
  entries.sort((a, b) => {
    // Things that stopped moving first, then by how long they have been
    // ignored: the oldest silence is the one most likely to have been
    // forgotten. This outranks the work in hand deliberately — a task being
    // actively worked is the one commitment that is NOT at risk, and does not
    // need a list to remind anyone it exists.
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    // Then the work in hand, above work merely owed and above free work.
    if (a.inFlight !== b.inFlight) return a.inFlight ? -1 : 1;
    const byRelation = RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation];
    if (byRelation !== 0) return byRelation;
    // Work that can be taken now before work still waiting on something.
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.status.updatedAt.localeCompare(b.status.updatedAt);
  });

  const counts: AgendaCounts = {
    assigned: 0,
    offered: 0,
    capable: 0,
    created: 0,
    unclaimed: 0,
    stale: 0,
    blocked: 0,
    stuck: 0,
    inFlight: 0,
    needsAttention: 0,
  };
  for (const entry of countUnclaimed ? [...owned, ...unclaimed] : owned) {
    counts[entry.relation] += 1;
    if (entry.inFlight) counts.inFlight += 1;
    if (entry.needsAttention) counts.needsAttention += 1;
    if (entry.relation === "unclaimed" || entry.relation === "capable") continue;
    if (entry.status.health === "stale") counts.stale += 1;
    else if (entry.status.health === "blocked") counts.blocked += 1;
    else if (entry.status.health === "stuck") counts.stuck += 1;
  }

  const limited =
    options.limit === undefined
      ? entries
      : entries.slice(0, Math.max(0, Math.floor(options.limit)));
  return { entries: limited, counts, inFlightThreads };
}
