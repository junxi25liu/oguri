/**
 * What `oguri web` reads, and the shapes it hands the page (ADR 0028).
 *
 * Everything goes through `ReadOnlyBackend`, so this module cannot write even
 * by mistake. Each part of the dashboard is read independently: one failing
 * read is reported in `errors` and the rest of the page still renders.
 */

import type { Agenda, InboxItem, MachineRow, PresenceRow, TaskStatus } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";
import type { RunRecord } from "@oguri/worker";

import { needsYou, sortNeedsYou, type NeedsYouItem } from "./needs-you.ts";

/** Messages shown per room, and how much of each body. */
const MESSAGES_PER_ROOM = 20;
const EXCERPT_CHARS = 500;
/**
 * Every backend method the dashboard may call. Each one only reads.
 *
 * Adding a method here is the only way to give the dashboard a new capability,
 * so a write can never slip in through a refactor of the routes.
 */
export const READ_METHODS = [
  "status",
  "machines",
  "presence",
  "agenda",
  "tasks",
  "read",
  "inbox",
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

export class ReadOnlyBackend {
  private readonly backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;
  }

  get mode(): Backend["mode"] {
    return this.backend.mode;
  }

  async call<T>(method: ReadMethod, params: Record<string, unknown> = {}): Promise<T> {
    if (!(READ_METHODS as readonly string[]).includes(method)) {
      throw new Error(`the dashboard does not call '${method}'`);
    }
    return await this.backend.call<T>(method, params);
  }
}

/** Drop credentials from a remote URL before it is shown anywhere. */
export function redactRemote(remote: string): string {
  try {
    const url = new URL(remote);
    if (url.username === "" && url.password === "") return remote;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote; // scp-style `git@host:path` carries no secret
  }
}

function excerpt(text: string): string {
  const flat = text.trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A task as the page shows it. Relationship fields appear only when the data has them. */
export interface TaskView {
  id: string;
  title: string;
  state: string;
  health: string;
  creator: string;
  assignee: string | null;
  assigneeMachine: string | null;
  target: string | null;
  updatedAt: string;
  stale: boolean;
  dependsOn: string[];
  parent: string | null;
  children: string[];
  /** The chat the task was requested in (ADR 0030), shown as a badge. */
  source: string | null;
  requester: string | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Flatten a task status for the page.
 *
 * `dependsOn`, `parent` and `children` are read defensively: task
 * relationships are added by a later protocol change, and the dashboard must
 * show them when present without failing when they are not.
 */
export function taskView(status: TaskStatus): TaskView {
  const task = status.task as TaskStatus["task"] & Record<string, unknown>;
  const loose = status as TaskStatus & Record<string, unknown>;
  const parent = task?.["parent"] ?? loose?.["parent"];
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    health: status.health,
    creator: task.creator,
    assignee: task.assignee ?? null,
    assigneeMachine: task.assigneeMachine ?? null,
    target: task.target ?? null,
    updatedAt: status.updatedAt,
    stale: status.stale,
    dependsOn: strings(task?.["dependsOn"] ?? loose?.["dependsOn"]),
    parent: typeof parent === "string" ? parent : null,
    children: strings(task?.["children"] ?? loose?.["children"]),
    source: task.origin?.source ?? null,
    requester: task.origin?.requester ?? null,
  };
}

export interface MessageView {
  id: string;
  from: string;
  ts: string;
  kind: string;
  needs: string;
  thread: string;
  taskId: string | null;
  /** The person a relayed chat message came from, as `source · name`. */
  external: string | null;
  relay: string | null;
  excerpt: string;
}

function messageView(message: Message): MessageView {
  const h = message.header;
  return {
    id: h.id,
    from: h.from,
    ts: h.ts,
    kind: h.kind,
    needs: h.needs,
    thread: h.thread,
    taskId: h.task?.id ?? null,
    external:
      h.external === undefined
        ? null
        : `${h.external.source} · ${h.external.actorName ?? h.external.actor}`,
    relay: h.relay ?? null,
    excerpt: excerpt(message.body),
  };
}

export interface HumanItem {
  id: string;
  room: string;
  from: string;
  ts: string;
  excerpt: string;
}

export function humanItem(item: InboxItem): HumanItem {
  return {
    id: item.id,
    room: item.room,
    from: item.from,
    ts: item.ts,
    excerpt: excerpt(item.body),
  };
}

interface StatusView {
  networkId: string;
  remote: string;
  agentId: string;
  subscriptions: string[];
  pending: number;
  pendingHuman: number;
  lastSyncAt: string | null;
  [key: string]: unknown;
}

export interface DashboardSources {
  backend: ReadOnlyBackend;
  /** This machine's worker runs. Local files, never the network. */
  listRuns: (limit: number) => Promise<RunRecord[]>;
}

/** Read one thing; on failure, record why and carry on with the rest. */
async function attempt<T>(errors: string[], what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors.push(`${what}: ${describe(error)}`);
    return null;
  }
}

export async function readStatus(sources: DashboardSources): Promise<StatusView> {
  const status = await sources.backend.call<StatusView>("status");
  return { ...status, remote: redactRemote(status.remote) };
}

export interface RoomView {
  room: string;
  tasks: TaskView[];
  messages: MessageView[];
  needsYou: NeedsYouItem[];
  error?: string;
}

export async function readRoom(sources: DashboardSources, room: string): Promise<RoomView> {
  const errors: string[] = [];
  // The whole live window, not just the recent page: an unanswered relay or
  // a blocked task can sit further back than the last few messages.
  const [tasks, messages] = await Promise.all([
    attempt(errors, "tasks", () => sources.backend.call<TaskStatus[]>("tasks", { room })),
    attempt(errors, "messages", () => sources.backend.call<Message[]>("read", { room })),
  ]);
  return {
    room,
    tasks: (tasks ?? []).map(taskView),
    messages: (messages ?? []).slice(-MESSAGES_PER_ROOM).map(messageView).reverse(),
    needsYou: needsYou(room, tasks ?? [], messages ?? []),
    ...(errors.length === 0 ? {} : { error: errors.join("; ") }),
  };
}

/** Everything the page shows, in one response, so one poll is one request. */
export async function readDashboard(sources: DashboardSources): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  const status = await attempt(errors, "status", () => readStatus(sources));
  const [machines, presence, agenda, human, runs] = await Promise.all([
    attempt(errors, "machines", () => sources.backend.call<MachineRow[]>("machines")),
    attempt(errors, "presence", () => sources.backend.call<PresenceRow[]>("presence")),
    attempt(errors, "agenda", () => sources.backend.call<Agenda>("agenda", { limit: 50 })),
    attempt(errors, "inbox", () => sources.backend.call<InboxItem[]>("inbox", { needs: "human" })),
    attempt(errors, "worker runs", () => sources.listRuns(20)),
  ]);
  const rooms = await Promise.all(
    (status?.subscriptions ?? []).map((room) => readRoom(sources, room)),
  );
  return {
    generatedAt: new Date().toISOString(),
    mode: sources.backend.mode,
    agent: status?.agentId ?? null,
    network: status?.networkId ?? null,
    status,
    machines,
    presence,
    agenda:
      agenda === null
        ? null
        : {
            counts: agenda.counts,
            entries: agenda.entries.map((entry) => ({
              room: entry.room,
              relation: entry.relation,
              needsAttention: entry.needsAttention,
              task: taskView(entry.status),
            })),
          },
    needsYou: sortNeedsYou(rooms.flatMap((room) => room.needsYou)),
    needsHuman: (human ?? []).map(humanItem),
    rooms,
    runs,
    errors,
  };
}
