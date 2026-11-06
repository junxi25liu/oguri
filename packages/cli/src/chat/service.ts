/**
 * The conversation behind `oguri chat` and the web `/chat` page (ADR 0031).
 *
 * Both surfaces use this one service, so they cannot disagree about what a
 * target means, which room a conversation lives in, or what counts as a reply.
 * A request is an ordinary immutable message tagged `to-big` or `to-small` in
 * the superagent conversation room; a superagent answers in the same thread
 * with `from-superagent`. Nothing here starts a superagent or a worker.
 *
 * The wire-shaped tags live here rather than in a new shared package: the CLI
 * already depends on `@oguri/superagent`, and duplicating them in the web layer
 * would let one surface drift away from the other.
 */

import type { MachineRow, PresenceRow } from "@oguri/core";
import {
  compareUlid,
  groupByThread,
  isAgentId,
  isMachineToken,
  machineFromToken,
  threadOrder,
  type Message,
} from "@oguri/protocol";
import { FROM_SUPERAGENT_TAG, SMALL_REPORT_TAG, TO_BIG_TAG, TO_SMALL_TAG } from "@oguri/superagent";

/** How many characters one chat message may carry. */
export const CHAT_MAX_CHARS = 16_000;
/** How many messages one history response may carry. */
export const CHAT_MAX_HISTORY = 200;
export const CHAT_DEFAULT_HISTORY = 100;
/** How long an unanswered request is reported as waiting, not lost. */
export const CHAT_DEFAULT_WAIT_MS = 300_000;
/** How often a waiting terminal checks the transport for a late reply. */
export const CHAT_POLL_MS = 3_000;
/** The room's live window is read in full; history is then trimmed by thread. */
const CHAT_READ_LIMIT = 500;

/** A chat target as the person names it. */
export type ChatTargetKind = "big" | "small";

export interface ChatTarget {
  kind: ChatTargetKind;
  /** The exact word to send back in links and messages: `big` or a small's name. */
  value: string;
  /** A machine's small is addressed by the one agent that runs its session. */
  mention?: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  from: string;
  ts: string;
  body: string;
  role: "you" | "them";
  state?: "sent" | "waiting" | "failed";
  inReplyTo?: string;
  /** The transport's thread id, so a follow-up stays in its conversation. */
  thread?: string;
}

/** A conversation thread, with its target and presence information. */
export interface ChatConversation {
  room: string;
  thread: string | null;
  target: ChatTarget;
  messages: ChatMessage[];
  /** `live` when a superagent session is observed; `unknown` is not offline. */
  presence: "live" | "away" | "stale" | "unknown";
  /** The latest request with no answer yet. Late replies remain in history. */
  waiting: boolean;
  /** A request has waited longer than the usual reply window. */
  timedOut: boolean;
  errors: string[];
}

/** The minimal read/write surface a chat needs. `Backend` satisfies it. */
export interface ChatBackend {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface ChatServiceOptions {
  backend: ChatBackend;
  /** Human-readable author id, used only to classify the thread's own side. */
  self: string;
  /** The room from machine-local `superagent.big.room`. */
  room: string;
  /** Optional clock and sleeper, so tests need no real waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Sync before each read. Disable when another loop owns the sync cadence. */
  sync?: boolean;
}

/** The tag on a request, and the one agent a small is addressed by. */
function addressing(target: ChatTarget): { tags: string[]; mentions: string[] } {
  return target.kind === "big"
    ? { tags: [TO_BIG_TAG], mentions: [] }
    : { tags: [TO_SMALL_TAG], mentions: [target.mention ?? target.value] };
}

/**
 * Parse one `target` value. `big` is the default; a bare agent id or a
 * `machine:<id>` token names a small superagent. The grammar is the same one
 * the routing and task layers use, so a name that cannot be delivered is
 * refused here instead of being silently sent into the void.
 */
export function parseChatTarget(value: string | null | undefined): ChatTarget {
  const raw = typeof value === "string" && value.trim() !== "" ? value.trim() : "big";
  if (raw === "big") return { kind: "big", value: "big", label: "Big superagent" };
  if (isMachineToken(raw)) {
    const machine = machineFromToken(raw) as string;
    return {
      kind: "small",
      value: raw,
      mention: raw,
      label: `Small superagent · ${machine}`,
    };
  }
  if (isAgentId(raw)) {
    return { kind: "small", value: raw, mention: raw, label: `Small superagent · ${raw}` };
  }
  throw new Error("target must be big, an agent id, or machine:<id>");
}

/** Validate a message before it becomes a permanent record in git. */
export function assertChatBody(body: string): string {
  const text = typeof body === "string" ? body.trim() : "";
  if (text === "") throw new Error("message must not be empty");
  if (text.length > CHAT_MAX_CHARS) {
    throw new Error(`message is too long (max ${String(CHAT_MAX_CHARS)} characters)`);
  }
  return text;
}

/** A ULID, so an optional `thread=` deep link cannot smuggle anything else in. */
export function isThreadId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** Reply messages from a superagent: header tags, never wording in the body. */
export function isChatReply(message: Message): boolean {
  return message.header.tags.includes(FROM_SUPERAGENT_TAG);
}

export function isChatNotice(message: Message): boolean {
  return message.header.tags.includes(SMALL_REPORT_TAG);
}

export function chatMessage(message: Message, self: string): ChatMessage {
  const header = message.header;
  return {
    id: header.id,
    from: header.from,
    ts: header.ts,
    body: message.body.trimEnd(),
    role: isChatReply(message) || header.from !== self ? "them" : "you",
    thread: header.thread,
    ...(header.inReplyTo === undefined ? {} : { inReplyTo: header.inReplyTo }),
  };
}

/** Whether a thread's first message was written by this author to this target. */
function rootBelongs(root: Message, target: ChatTarget, self: string): boolean {
  const tags = root.header.tags;
  if (root.header.from !== self || root.header.inReplyTo !== undefined) return false;
  if (target.kind === "big") return tags.includes(TO_BIG_TAG);
  if (!tags.includes(TO_SMALL_TAG)) return false;
  const mentions = root.header.mentions;
  return mentions.includes(target.value) || mentions.includes(target.mention ?? "\0");
}

/** All thread roots in chronological (ULID) order, oldest first. */
function rootsInOrder(messages: readonly Message[]): Message[] {
  return messages
    .filter((message) => message.header.inReplyTo === undefined)
    .sort((a, b) => a.header.id.localeCompare(b.header.id));
}

/** Thread roots this author started with this target, oldest first. */
function ownedThreads(messages: readonly Message[], target: ChatTarget, self: string): string[] {
  return rootsInOrder(messages)
    .filter((root) => rootBelongs(root, target, self))
    .map((root) => root.header.thread);
}

/**
 * A superagent that hits the room's reply budget starts a new thread. It still
 * mentions its author, so that late answer remains readable without inventing
 * a conversation that was never ours. Its root is a reply, not a request, so
 * follow the inReplyTo chain back to a request this author owns.
 */
function lateReplyThreads(
  messages: readonly Message[],
  target: ChatTarget,
  self: string,
): string[] {
  const small = target.kind === "small" ? (target.mention ?? target.value) : undefined;
  const byId = new Map(messages.map((message) => [message.header.id, message]));
  const owned = new Set(ownedThreads(messages, target, self));
  const found = new Set<string>();
  for (const message of messages) {
    if (
      !isChatReply(message) ||
      message.header.inReplyTo === undefined ||
      (small !== undefined && message.header.from !== small) ||
      (!message.header.mentions.includes(self) && message.header.from !== self)
    ) {
      continue;
    }
    let parent = byId.get(message.header.inReplyTo);
    for (let depth = 0; parent !== undefined && depth < 32; depth += 1) {
      if (owned.has(parent.header.thread)) {
        found.add(message.header.thread);
        break;
      }
      parent =
        parent.header.inReplyTo === undefined ? undefined : byId.get(parent.header.inReplyTo);
    }
  }
  return [...found];
}

/** Request ids this author wrote in this thread to this target. */
function ownedRequestIds(group: readonly Message[], target: ChatTarget, self: string): Set<string> {
  const requestTag = target.kind === "big" ? TO_BIG_TAG : TO_SMALL_TAG;
  const wanted = target.mention ?? target.value;
  return new Set(
    group
      .filter(
        (message) =>
          message.header.from === self &&
          message.header.tags.includes(requestTag) &&
          (target.kind === "big" || message.header.mentions.includes(wanted)) &&
          !isChatReply(message) &&
          !isChatNotice(message) &&
          !message.header.tags.includes("task"),
      )
      .map((message) => message.header.id),
  );
}

/** Hide a reply to another person's request when both share one thread. */
function visibleIds(
  group: readonly Message[],
  target: ChatTarget,
  self: string,
  owned: ReadonlySet<string>,
): Set<string> {
  const small = target.kind === "small" ? (target.mention ?? target.value) : undefined;
  const visible = new Set(owned);
  for (const message of group) {
    // A shared thread can also carry someone else's message or a reply to it.
    // Show only this author's requests and the intended superagent's answers.
    // A local superagent can share self; its reply tag identifies its side.
    if (
      isChatReply(message) &&
      (small === undefined || message.header.from === small) &&
      (message.header.mentions.includes(self) ||
        (message.header.inReplyTo !== undefined && owned.has(message.header.inReplyTo)))
    ) {
      visible.add(message.header.id);
    }
  }
  return visible;
}

/** The latest request to this target still without a superagent's answer. */
function pendingRequest(messages: readonly ChatMessage[]): ChatMessage | undefined {
  const answered = new Set(
    messages
      .filter((message) => message.role === "them" && message.inReplyTo !== undefined)
      .map((message) => message.inReplyTo)
      .filter((id): id is string => id !== undefined),
  );
  return [...messages]
    .reverse()
    .find((message) => message.role === "you" && !answered.has(message.id));
}

export class ChatService {
  private readonly backend: ChatBackend;
  private readonly self: string;
  private readonly room: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sync: boolean;
  private joined = false;
  /** Empty conversations started by this process until the transport catches up. */
  private readonly pending = new Set<string>();

  constructor(options: ChatServiceOptions) {
    this.backend = options.backend;
    this.self = options.self;
    this.room = options.room;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.sync = options.sync !== false;
  }

  /** Create/join the conversation room once, exactly as `oguri big` does. */
  async ensureJoined(): Promise<void> {
    if (this.joined) return;
    const status = await this.backend.call<{ subscriptions: string[] }>("status");
    if (!status.subscriptions.includes(this.room)) {
      try {
        await this.backend.call("roomJoin", { room: this.room });
      } catch {
        try {
          // Superagent conversations are long; the generic budget would park them.
          await this.backend.call("roomCreate", {
            room: this.room,
            title: "Superagent",
            purpose: "Talk to the superagents here.",
            replyBudget: 500,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already exists/.test(message)) throw error;
          await this.backend.call("roomJoin", { room: this.room });
        }
      }
    }
    this.joined = true;
  }

  /** Pull once. A temporary remote failure must not look like an empty room. */
  async syncOnce(): Promise<void> {
    if (this.sync) await this.backend.call("sync").catch(() => undefined);
  }

  /** Read the room's live window, shared by history and wait. */
  async readRoom(): Promise<Message[]> {
    return await this.backend.call<Message[]>("read", {
      room: this.room,
      limit: CHAT_READ_LIMIT,
    });
  }

  /**
   * Resolve a machine token to the one agent running its small superagent.
   * `oguri small` does the same: a machine with several agents would otherwise
   * receive the request more than once. A bare agent id is used as named.
   */
  async resolve(target: ChatTarget): Promise<{ target: ChatTarget; errors: string[] }> {
    const errors: string[] = [];
    if (target.kind === "big" || !isMachineToken(target.value)) {
      return { target, errors };
    }
    let machines: MachineRow[] = [];
    try {
      machines = await this.backend.call<MachineRow[]>("machines");
    } catch (error) {
      return {
        target,
        errors: [`machines: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    const machineId = machineFromToken(target.value);
    const row = machines.find((entry) => entry.id === machineId);
    const agents = row?.agents.map((agent) => agent.id) ?? [];
    if (agents.length === 1) {
      return {
        target: { ...target, mention: agents[0] as string },
        errors,
      };
    }
    errors.push(
      agents.length === 0
        ? `no agent is known on ${target.value}; see 'oguri agents'`
        : `${target.value} has several agents (${agents.join(", ")}); name one`,
    );
    return { target, errors };
  }

  /**
   * Send one message. Follow-ups stay in the same thread; the transport's own
   * `thread`/`inReplyTo` rules do the rest. A repeated poll or a retried HTTP
   * request never calls this twice by itself.
   */
  async send(target: ChatTarget, body: string, thread?: string): Promise<ChatMessage> {
    const text = assertChatBody(body);
    if (thread !== undefined && !isThreadId(thread)) {
      throw new TypeError("thread must be a message id");
    }
    const resolved = await this.resolve(target);
    if (resolved.errors.length > 0) throw new Error(resolved.errors.join("; "));
    await this.ensureJoined();
    const address = addressing(resolved.target);
    const sent = await this.backend.call<Message>("send", {
      room: this.room,
      input: {
        body: text,
        kind: "msg",
        needs: "none",
        tags: address.tags,
        ...(address.mentions.length > 0 ? { mentions: address.mentions } : {}),
        ...(thread === undefined ? {} : { inReplyTo: thread }),
      },
    });
    const message = chatMessage(sent, this.self);
    // A root is not in the transport's read window on every backend. Remember
    // it so an immediate history cannot report that the write never happened.
    this.pending.add(message.thread ?? message.id);
    return message;
  }

  /** One conversation, filtered by target and thread, oldest first. */
  async history(
    target: ChatTarget,
    options: { thread?: string; limit?: number } = {},
  ): Promise<ChatConversation> {
    const limit = Math.min(
      CHAT_MAX_HISTORY,
      Math.max(1, Math.floor(options.limit ?? CHAT_DEFAULT_HISTORY)),
    );
    const errors: string[] = [];
    const resolved = await this.resolve(target);
    errors.push(...resolved.errors);
    let messages: Message[] = [];
    try {
      await this.syncOnce();
      messages = await this.readRoom();
    } catch (error) {
      errors.push(`read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const named = isThreadId(options.thread) ? options.thread : undefined;
    const owned = ownedThreads(messages, resolved.target, this.self);
    const late = lateReplyThreads(messages, resolved.target, this.self);
    const known = new Set(messages.map((message) => message.header.thread));
    for (const id of this.pending) if (known.has(id)) this.pending.delete(id);
    // All of this author's conversations with one target read as one chat.
    // An explicit thread must be one of ours for THIS target, never a deep
    // link into a different person's or a different superagent's history.
    const ours = new Set([...owned, ...late, ...this.pending]);
    const chosen =
      named === undefined ? ours : ours.has(named) ? new Set([named]) : new Set<string>();
    const groups = groupByThread(messages);
    const ownedRequests = ownedRequestIds(messages, resolved.target, this.self);
    const inThread = threadOrder(
      [...chosen]
        .sort(compareUlid)
        .flatMap((thread) => {
          const group = groups.get(thread) ?? [];
          const visible = visibleIds(group, resolved.target, this.self, ownedRequests);
          return group.filter((message) => visible.has(message.header.id));
        })
        .filter((message) => !message.header.tags.includes("task") && !isChatNotice(message)),
    ).slice(-limit);
    const shown = inThread.map((message) => chatMessage(message, this.self));
    const thread =
      named ?? (chosen.size > 0 ? ([...chosen].sort(compareUlid).at(-1) ?? null) : null);
    const knownThread = thread !== null && chosen.has(thread);
    const presence = await this.presence(resolved.target, errors);
    const pending = pendingRequest(shown);
    const age = pending === undefined ? Number.NaN : this.now() - Date.parse(pending.ts);
    const waiting = pending !== undefined && age >= 0 && age < CHAT_DEFAULT_WAIT_MS;
    const timedOut = pending !== undefined && age >= CHAT_DEFAULT_WAIT_MS;
    return {
      room: this.room,
      thread: knownThread ? thread : null,
      target: resolved.target,
      messages: shown,
      presence,
      waiting,
      timedOut,
      errors,
    };
  }

  /**
   * Wait for a new reply to one request. This only READS. It never resends,
   * restarts, or redeploys anything, so a refresh, a timeout, or several open
   * tabs cannot duplicate a task. Late replies remain readable in history.
   */
  async waitForReply(
    target: ChatTarget,
    requestId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ChatConversation> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? CHAT_DEFAULT_WAIT_MS);
    const deadline = this.now() + timeoutMs;
    while (options.signal?.aborted !== true) {
      await this.syncOnce();
      const messages = await this.readRoom();
      const request = messages.find((message) => message.header.id === requestId);
      const replies = messages.filter(
        (message) =>
          message.header.inReplyTo === requestId &&
          message.header.thread === (request?.header.thread ?? "") &&
          isChatReply(message),
      );
      if (replies.length > 0) {
        const conversation = await this.history(
          target,
          request?.header.thread === undefined ? {} : { thread: request.header.thread },
        );
        return { ...conversation, waiting: false, timedOut: false };
      }
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(CHAT_POLL_MS, Math.max(0, deadline - this.now())));
    }
    const messages = await this.readRoom().catch(() => [] as Message[]);
    const thread = messages.find((message) => message.header.id === requestId)?.header.thread;
    const conversation = await this.history(target, thread === undefined ? {} : { thread });
    return { ...conversation, waiting: true, timedOut: true };
  }

  /** Targets a person can choose: Big and one row per concrete small agent. */
  async targets(): Promise<ChatTarget[]> {
    let machines: MachineRow[] = [];
    try {
      machines = await this.backend.call<MachineRow[]>("machines");
    } catch {
      machines = [];
    }
    const byValue = new Map<string, ChatTarget>();
    byValue.set("big", parseChatTarget("big"));
    for (const machine of machines) {
      if (machine.id === null || machine.agents.length === 0) continue;
      for (const agent of machine.agents) {
        const value = agent.id;
        if (!byValue.has(value)) {
          byValue.set(value, {
            kind: "small",
            value,
            mention: value,
            label: `Small · ${value} · ${machine.label ?? machine.id}`,
          });
        }
      }
    }
    return [...byValue.values()];
  }

  private async presence(
    target: ChatTarget,
    errors: string[],
  ): Promise<ChatConversation["presence"]> {
    if (target.kind === "big") return "unknown";
    try {
      const rows = await this.backend.call<PresenceRow[]>("presence");
      const named = target.mention ?? target.value;
      const row = rows.find((entry) => entry.id === named);
      if (row === undefined) return "unknown";
      return row.status === "live" || row.status === "away" || row.status === "stale"
        ? row.status
        : "unknown";
    } catch (error) {
      errors.push(`presence: ${error instanceof Error ? error.message : String(error)}`);
      return "unknown";
    }
  }
}
