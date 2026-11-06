/**
 * A fake `Backend` with tasks a test can shape, for the task-graph worker tests.
 *
 * Answers `agenda` from the entries given, `taskShow` from the task map, and
 * records every call. `taskClaim` returns a message carrying the next attempt,
 * as the real one does, unless the test throws a coded refusal instead.
 */

import { DEFAULT_WORKER_POLICY, type Agenda, type WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import {
  ulid,
  type ExternalRef,
  type Message,
  type Priority,
  type TaskOrigin,
} from "@oguri/protocol";

import type { RunResult } from "../src/runner.ts";

export const ME = "bob-claude";

export function policy(overrides: Partial<WorkerPolicy> = {}): WorkerPolicy {
  return {
    ...DEFAULT_WORKER_POLICY,
    enabled: true,
    runners: { claude: { argv: ["claude", "-p"], worktree: false } },
    trustedRequesters: [],
    capabilities: [],
    retry: { backoffMinutes: 10 },
    ...overrides,
  };
}

export function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1200,
    stdoutTail: "all done",
    ...overrides,
  };
}

export interface FakeTask {
  id: string;
  title?: string;
  state?: string;
  assignee?: string;
  creator?: string;
  definition?: string;
  relation?: string;
  ready?: boolean;
  requires?: string[];
  attempt?: number;
  maxAttempts?: number;
  waitingOn?: { id: string; state: string }[];
  children?: { id: string; state: string }[];
  parent?: string;
  dependsOn?: string[];
  /** Events for `taskShow`, oldest first. */
  events?: {
    action: string;
    from?: string;
    body?: string;
    needs?: string;
    refs?: string[];
    ts?: string;
  }[];
  /** Leave off the agenda; still answerable through `taskShow`. */
  hidden?: boolean;
  /** The task's thread; defaults to its id, as for a real task. */
  thread?: string;
  origin?: TaskOrigin;
  /** The priority its creator gave it; the agenda always carries one, default `normal`. */
  priority?: Priority;
  /** Events for `taskShow` carry this time when they name none. */
  eventTs?: string;
}

export const ORIGIN: TaskOrigin = {
  source: "feishu",
  conversation: "oc_chat",
  message: "om_request",
  requester: "ou_alice",
};

/** A message in a task thread, as `read` returns it. */
export function threadMessage(
  thread: string,
  body: string,
  options: {
    from?: string;
    ts?: string;
    external?: Partial<ExternalRef>;
    relay?: Message["header"]["relay"];
    inReplyTo?: string;
    tags?: string[];
  } = {},
): Message {
  const ts = options.ts ?? new Date().toISOString();
  return {
    header: {
      v: 1,
      id: ulid(Date.parse(ts)),
      room: "ops",
      // The fake tasks are created by alice-claude, standing in for intake: a chat
      // task's follow-ups are written by its creator (see `followupAuthors`).
      from: options.from ?? "alice-claude",
      authorKind: "agent",
      ts,
      kind: "msg",
      thread,
      needs: "none",
      mentions: [],
      priority: "normal",
      tags: options.tags ?? [],
      refs: [],
      extra: {},
      ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
      ...(options.relay === undefined ? {} : { relay: options.relay }),
      ...(options.external === undefined
        ? {}
        : {
            external: {
              source: "feishu",
              id: `om_${ulid()}`,
              actor: "ou_alice",
              actorName: "Alice",
              human: true,
              ...options.external,
            },
          }),
    },
    body,
  };
}

function status(t: FakeTask) {
  return {
    task: {
      id: t.id,
      title: t.title ?? `task ${t.id.slice(-3)}`,
      creator: t.creator ?? "alice-claude",
      state: t.state ?? "open",
      action: "created",
      staleAfterSeconds: 86400,
      ...(t.assignee === undefined ? {} : { assignee: t.assignee }),
      ...(t.requires === undefined ? {} : { requires: t.requires }),
      ...(t.attempt === undefined ? {} : { attempt: t.attempt }),
      ...(t.maxAttempts === undefined ? {} : { maxAttempts: t.maxAttempts }),
      ...(t.origin === undefined ? {} : { origin: t.origin }),
      ...(t.parent === undefined ? {} : { parent: t.parent }),
      ...(t.dependsOn === undefined ? {} : { dependsOn: t.dependsOn }),
    },
    thread: t.thread ?? t.id,
    rootMessageId: t.thread ?? t.id,
    definition: t.definition ?? "Do the thing.",
    priority: t.priority ?? "normal",
    waitingOn: t.waitingOn ?? [],
    children: t.children ?? [],
  };
}

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export function fakeBackend(
  tasks: FakeTask[],
  hooks: {
    onClaim?: (params: Record<string, unknown>) => void;
    profile?: { capabilities: string[] } | null;
    /** The room's messages, answered by `read`; `send` appends to it. */
    messages?: Message[];
  } = {},
) {
  const calls: Call[] = [];
  const messages = hooks.messages ?? [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let profile = hooks.profile === undefined ? { capabilities: ["Free text"] } : hooks.profile;

  const agenda = (): Agenda =>
    ({
      entries: tasks
        .filter((t) => t.hidden !== true)
        .map((t) => ({
          room: "ops",
          relation: t.relation ?? (t.assignee === ME ? "assigned" : "offered"),
          inFlight: false,
          needsAttention: false,
          ready: t.ready ?? true,
          status: status(t),
        })),
      counts: {},
      inFlightThreads: [],
    }) as unknown as Agenda;

  const backend: Backend = {
    mode: "direct",
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "agenda":
          return agenda() as T;
        case "taskShow": {
          const t = byId.get(params["taskId"] as string);
          if (t === undefined) throw new Error(`no task ${String(params["taskId"])}`);
          // An in-flight run's own task: still ours unless the test says otherwise.
          const view = t.state === "open" ? { ...t, state: "in_progress", assignee: ME } : t;
          return {
            ...status(view),
            events: (t.events ?? []).map((e) => ({
              from: e.from ?? ME,
              body: e.body ?? "",
              needs: e.needs ?? "none",
              refs: e.refs ?? [],
              action: e.action,
              ts: e.ts ?? t.eventTs ?? new Date().toISOString(),
            })),
          } as T;
        }
        case "taskClaim": {
          hooks.onClaim?.(params);
          const t = byId.get(params["taskId"] as string);
          return { header: { task: { attempt: (t?.attempt ?? 0) + 1 } } } as T;
        }
        case "read": {
          const thread = params["thread"] as string | undefined;
          return messages.filter((m) => thread === undefined || m.header.thread === thread) as T;
        }
        case "send": {
          const input = params["input"] as {
            body: string;
            thread?: string;
            inReplyTo?: string;
            relay?: Message["header"]["relay"];
          };
          const message = threadMessage(input.thread ?? "", input.body, {
            from: ME,
            ...(input.relay === undefined ? {} : { relay: input.relay }),
            ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          });
          messages.push(message);
          return message as T;
        }
        case "profileGet":
          return profile as T;
        case "profileUpdate": {
          const input = params["input"] as { capabilities: string[] };
          profile = { ...profile, capabilities: input.capabilities };
          return { published: true, profile } as T;
        }
        default:
          return {} as T;
      }
    },
    async networks() {
      return [];
    },
    async close() {},
  };

  const updates = () =>
    calls
      .filter((c) => c.method === "taskUpdate")
      .map(
        (c) =>
          ({ taskId: c.params["taskId"], ...(c.params["input"] as object) }) as {
            taskId: string;
            action: string;
            body: string;
            refs?: string[];
            needsHuman?: boolean;
          },
      );
  const sent = () =>
    calls
      .filter((c) => c.method === "send")
      .map((c) => c.params["input"] as { body: string; relay?: string; inReplyTo?: string });
  return { backend, calls, updates, sent, messages, byId, profile: () => profile };
}

export function coded(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
