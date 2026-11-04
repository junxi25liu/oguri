/**
 * Room messages for intake tests, built with the protocol's own constructors
 * so the reducer accepts them exactly as it would accept real ones.
 */

import {
  createMessage,
  createTask,
  ulid,
  type ExternalRef,
  type Message,
  type Needs,
  type RelayPurpose,
  type Task,
  type TaskOrigin,
} from "@oguri/protocol";

export const ROOM = "ops";
export const INTAKE = "intake-bot";
export const WORKER = "bob-worker";

export const ORIGIN: TaskOrigin = {
  source: "feishu",
  conversation: "oc_team",
  message: "om_request",
  requester: "ou_alice",
};

/**
 * A clock the messages are minted on, so ULID times and `ts` agree and a test
 * can place a message before or after any moment it likes.
 */
export class Timeline {
  /**
   * ULIDs are monotonic per process, so a timeline must never run behind one
   * an earlier test used: each starts an hour after the latest time so far.
   * It starts a month back, so it stays behind the real clock that messages
   * written through a real `Network` in the same process are minted on.
   */
  private static latest = Date.now() - 30 * 24 * 60 * 60_000;
  at: number;
  constructor() {
    this.at = Timeline.latest + 60 * 60_000;
    Timeline.latest = this.at;
  }
  /** Advance and return the new time. */
  tick(ms = 1_000): number {
    this.at += ms;
    Timeline.latest = Math.max(Timeline.latest, this.at);
    return this.at;
  }
}

export class TaskThread {
  readonly messages: Message[] = [];
  task: Task;
  root: Message;
  private current: Message;
  private readonly time: Timeline;

  constructor(time: Timeline, options: { origin?: TaskOrigin | null; title?: string } = {}) {
    this.time = time;
    const origin = options.origin === null ? undefined : (options.origin ?? ORIGIN);
    const at = time.tick();
    const id = ulid(at);
    this.task = createTask({
      id: ulid(at),
      creator: INTAKE,
      title: options.title ?? "Fix the login button",
      target: WORKER,
      ...(origin === undefined ? {} : { origin }),
    });
    this.root = createMessage({
      id,
      room: ROOM,
      from: INTAKE,
      authorKind: "agent",
      kind: "question",
      needs: "agent",
      body: "Please fix the login button.",
      ts: new Date(at).toISOString(),
      mentions: [WORKER],
      task: this.task,
    });
    this.messages.push(this.root);
    this.current = this.root;
  }

  get thread(): string {
    return this.root.header.id;
  }

  /** Append a task event as `from`, or as the assignee. */
  event(
    action: Task["action"],
    options: { body?: string; refs?: string[]; needs?: Needs; from?: string } = {},
  ): Message {
    const from = options.from ?? WORKER;
    const state: Record<string, Task["state"]> = {
      claimed: "claimed",
      started: "in_progress",
      progressed: "in_progress",
      blocked: "blocked",
      completed: "completed",
      cancelled: "cancelled",
    };
    const next: Task = {
      ...this.task,
      action,
      state: state[action] ?? this.task.state,
      ...(action === "claimed" ? { assignee: from, attempt: (this.task.attempt ?? 0) + 1 } : {}),
    };
    const needs: Needs =
      options.needs ??
      (next.state === "open" || next.state === "blocked" || next.state === "stuck"
        ? "agent"
        : "none");
    const at = this.time.tick();
    const message = createMessage({
      id: ulid(at),
      room: ROOM,
      from,
      authorKind: "agent",
      kind: "status",
      needs,
      body: options.body ?? `${action}.`,
      ts: new Date(at).toISOString(),
      thread: this.thread,
      inReplyTo: this.current.header.id,
      refs: options.refs ?? [],
      task: next,
    });
    this.messages.push(message);
    this.task = next;
    this.current = message;
    return message;
  }

  /** Claim and start, as a worker does. */
  run(): this {
    this.event("claimed");
    this.event("started");
    return this;
  }

  /** A plain message in the thread: a relay, or a person's words relayed in. */
  say(
    body: string,
    options: {
      relay?: RelayPurpose;
      external?: ExternalRef;
      inReplyTo?: string;
      from?: string;
      authorKind?: "agent" | "human";
      thread?: string;
    } = {},
  ): Message {
    const at = this.time.tick();
    const message = createMessage({
      id: ulid(at),
      room: ROOM,
      from: options.from ?? (options.external === undefined ? WORKER : INTAKE),
      authorKind: options.authorKind ?? (options.external === undefined ? "agent" : "human"),
      kind: "msg",
      needs: "none",
      body,
      ts: new Date(at).toISOString(),
      thread: options.thread ?? this.thread,
      inReplyTo: options.inReplyTo ?? this.root.header.id,
      ...(options.relay === undefined ? {} : { relay: options.relay }),
      ...(options.external === undefined ? {} : { external: options.external }),
    });
    this.messages.push(message);
    return message;
  }

  /** A person's follow-up in the Feishu thread, as intake relays it in. */
  followup(body: string, id = "om_followup"): Message {
    return this.say(body, {
      external: {
        source: "feishu",
        id,
        conversation: ORIGIN.conversation,
        actor: "ou_alice",
        human: true,
      },
    });
  }
}
