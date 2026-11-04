/**
 * The big superagent (ADR 0031): the one agent you talk to.
 *
 * Each pass it reads the conversation room for messages to it, decides what
 * each one is, and acts: deploys workers on the right machines, passes a
 * message to a worker, moves or stops one, or answers. It follows the workers
 * it deployed and tells you, in the same conversation, when one finishes or
 * needs you. With `coordinate`, it also acts on the small superagents'
 * reports: a worker waiting for a machine that is away is moved, and anything
 * that needs you is said once.
 *
 * It never runs a worker. Every machine's small superagent does that.
 */

import {
  describeError,
  type SuperagentPolicy,
  type TaskDetail,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { execGh, GH_TIMEOUT_MS, parsePrView, prUrlsIn, type GhRunner } from "@oguri/intake";
import type { Message } from "@oguri/protocol";

import {
  act,
  BIG_KINDS,
  COORDINATOR_KINDS,
  decide,
  ensureRoom,
  FROM_SUPERAGENT_TAG,
  reply,
  SMALL_REPORT_TAG,
  TO_BIG_TAG,
  type Conversation,
} from "./act.ts";
import type { RouteDecision } from "./decision.ts";
import { MindHolder, type Mind } from "./mind.ts";
import { langOf, words, type Lang } from "./words.ts";
import { resolveThinker, type AskModel } from "./model.ts";
import {
  MAX_ATTEMPTS,
  MAX_NOTICES,
  readSuperagentState,
  writeSuperagentState,
  type SuperagentState,
  type Tracked,
} from "./state.ts";

export interface BigOptions {
  backend: Backend;
  agentId: string;
  home: string;
  loadPolicy: () => Promise<{ superagent: SuperagentPolicy; worker: WorkerPolicy }>;
  ask?: AskModel;
  /** Runs the GitHub CLI; injectable, so tests need no `gh`. */
  gh?: GhRunner;
  now?: () => number;
  log?: (line: string) => void;
}

/** Tag on a worker's question (`oguri_task action=ask`). */
export const QUESTION_TAG = "task-question";
/** Tag on a worker's handback from a task with no chat (`oguri_task action=handback`). */
export const HANDBACK_TAG = "task-handback";
/** How often a followed pull request is checked. */
const PR_CHECK_MS = 5 * 60_000;
/** How long an open pull request is followed after its task completed. */
const PR_FOLLOW_DAYS = 30;

/** What happened to a request: a decision, none, or tried again on a later pass. */
export type Handled = RouteDecision["kind"] | "undecided" | "deferred";

export interface BigReport {
  enabled: boolean;
  handled: { messageId: string; decision: Handled }[];
  told: { taskId: string; event: string }[];
  coordinated: { key: string; decision: RouteDecision["kind"] | "undecided" }[];
}

/** Requests handled per pass, so one burst cannot hold the loop for long. */
const MAX_REQUESTS_PER_PASS = 5;
/** Coordination decisions per pass: each one is a model call. */
const MAX_COORDINATION_PER_PASS = 3;
/** A deployed worker nobody has picked up for this long is a situation. */
const UNCLAIMED_MINUTES = 30;
/** Workers are followed this long after they end, then forgotten. */
const FOLLOW_DAYS = 7;
const CONTEXT_MESSAGES = 8;
const TOLD_CHARS = 600;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Where workers' tasks go: their own room by default, so the conversation
 * room holds only what the owner and the superagents say. A task definition,
 * its progress, and its result are long; mixed into the conversation they
 * buried Big's replies.
 */
export function workRoom(policy: SuperagentPolicy): string {
  return policy.big.workRoom ?? `${policy.big.room}-work`;
}

/**
 * Every room a superagent finds its workers in: the work room, and the
 * conversation room, where workers deployed before the work room had its own
 * name still are.
 */
export function workerRooms(policy: SuperagentPolicy): string[] {
  const work = workRoom(policy);
  return work === policy.big.room ? [work] : [work, policy.big.room];
}

/** A message the big superagent should act on. */
export function isBigRequest(
  message: Message,
  state: Pick<SuperagentState, "handled" | "since">,
): boolean {
  const tags = message.header.tags;
  return (
    tags.includes(TO_BIG_TAG) &&
    !tags.includes(FROM_SUPERAGENT_TAG) &&
    !state.handled.includes(message.header.id) &&
    Date.parse(message.header.ts) >= Date.parse(state.since)
  );
}

/**
 * Requests grouped by conversation, in the order they came: messages that
 * arrived together in one thread are decided once, as a live superagent batches
 * the requests a thread queued while its evaluation ran.
 */
export function batchesOf(requests: readonly Message[]): Message[][] {
  const byThread = new Map<string, Message[]>();
  for (const message of requests) {
    const batch = byThread.get(message.header.thread);
    if (batch === undefined) byThread.set(message.header.thread, [message]);
    else batch.push(message);
  }
  return [...byThread.values()];
}

/** One batch as the conversation it is decided in; replies go under its newest message. */
export function batchConversation(
  batch: readonly Message[],
  messages: readonly Message[],
): Conversation {
  const first = batch[0] as Message;
  const last = batch.at(-1) as Message;
  const text =
    batch.length === 1
      ? last.body
      : `Several messages arrived together in this conversation; decide once for all of them:\n\n${batch.map((m) => `${m.header.from}: ${m.body}`).join("\n\n")}`;
  return {
    room: last.header.room,
    messageId: last.header.id,
    thread: last.header.thread,
    author: last.header.from,
    text,
    context: contextOf(messages, first),
  };
}

/** Earlier messages in the same thread, oldest first. */
export function contextOf(
  messages: readonly Message[],
  message: Message,
): { author: string; text: string }[] {
  return messages
    .filter((m) => m.header.thread === message.header.thread && m.header.id < message.header.id)
    .slice(-CONTEXT_MESSAGES)
    .map((m) => ({
      author: m.header.tags.includes(FROM_SUPERAGENT_TAG)
        ? `${m.header.from} (superagent)`
        : m.header.from,
      text: clip(m.body, 500),
    }));
}

/** What the owner is told when a worker's task moves, or null when it needs no word. */
export function toldText(detail: TaskDetail, quiet: boolean, lang: Lang = "en"): string | null {
  const say = words(lang);
  const event = detail.events.at(-1);
  if (event === undefined) return null;
  const title = detail.task.title;
  if (event.action === "completed" && !quiet)
    return `${say.done(title)}\n${clip(event.body, TOLD_CHARS)}`;
  if (event.action === "blocked") return `${say.waiting(title)}\n${clip(event.body, TOLD_CHARS)}`;
  return null;
}

export class BigSuperagent {
  private readonly options: BigOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly minds: MindHolder;
  /** This pass's standing session. */
  private mind: Mind | undefined;

  constructor(options: BigOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.minds = new MindHolder({
      home: options.home,
      name: "big",
      ...(options.ask === undefined ? {} : { ask: options.ask }),
      log: this.log,
    });
  }

  /** End the standing session's process, if it keeps one. Its id stays for the next start. */
  async close(): Promise<void> {
    await this.minds.close();
    this.mind = undefined;
  }

  async pass(signal?: AbortSignal): Promise<BigReport> {
    const { superagent, worker } = await this.options.loadPolicy();
    const report: BigReport = {
      enabled: superagent.big.enabled,
      handled: [],
      told: [],
      coordinated: [],
    };
    if (!superagent.big.enabled) return report;
    const { backend, agentId, home } = this.options;
    const room = superagent.big.room;
    const work = workRoom(superagent);
    await ensureRoom(backend, room, "Talk to the big superagent here.");
    if (work !== room) await ensureRoom(backend, work, "Workers deployed by the big superagent.");
    await backend
      .call("sync")
      .catch((error: unknown) => this.log(`sync failed: ${describeError(error)}`));

    const state = await readSuperagentState(home, "big", this.now());
    try {
      const messages = await backend.call<Message[]>("read", { room });
      this.mind = await this.minds.get(thinkerOf(worker, superagent.big.runner));
      const batches = batchesOf(messages.filter((m) => isBigRequest(m, state))).slice(
        0,
        MAX_REQUESTS_PER_PASS,
      );
      for (const batch of batches) {
        if (signal?.aborted === true) break;
        const kind = await this.handle(batch, messages, state, superagent, worker, signal);
        report.handled.push({ messageId: (batch.at(-1) as Message).header.id, decision: kind });
        if (kind !== "deferred") for (const m of batch) state.handled.push(m.header.id);
        await writeSuperagentState(home, "big", state);
      }
      report.told.push(...(await this.follow(state, superagent, worker, signal)));
      if (superagent.big.coordinate) {
        report.coordinated.push(...(await this.coordinate(state, superagent, worker, signal)));
      }
    } finally {
      await writeSuperagentState(home, "big", state);
    }
    void agentId;
    return report;
  }

  private async handle(
    batch: readonly Message[],
    messages: readonly Message[],
    state: SuperagentState,
    superagent: SuperagentPolicy,
    worker: WorkerPolicy,
    signal?: AbortSignal,
  ): Promise<Handled> {
    const { backend, agentId } = this.options;
    const conversation = batchConversation(batch, messages);
    const key = (batch[0] as Message).header.id;
    const work = workRoom(superagent);
    const related = new Set(
      Object.entries(state.tracked)
        .filter(([, tracked]) => tracked.conversation.thread === conversation.thread)
        .map(([taskId]) => taskId),
    );
    const decided = await decide(conversation, {
      backend,
      worker,
      role: "big",
      kinds: BIG_KINDS,
      self: agentId,
      timeoutSeconds: superagent.big.timeoutSeconds,
      rooms: workerRooms(superagent),
      defaultRoom: work,
      related,
      now: this.now(),
      ...(superagent.big.runner === undefined ? {} : { runner: superagent.big.runner }),
      ...(this.options.ask === undefined ? {} : { ask: this.options.ask }),
      ...(this.mind === undefined ? {} : { mind: this.mind }),
      notices: state.notices,
      ...(signal === undefined ? {} : { signal }),
    });
    if (decided.decision === null) {
      if (decided.retry === true) {
        // The model did not answer: ask again on a later pass, twice, then give up.
        const attempts = (state.attempts[key] ?? 0) + 1;
        if (attempts < MAX_ATTEMPTS) {
          state.attempts[key] = attempts;
          this.log(
            `${conversation.messageId}: no answer (${decided.why ?? "unknown"}); try ${String(attempts + 1)} of ${String(MAX_ATTEMPTS)} next pass`,
          );
          return "deferred";
        }
      }
      delete state.attempts[key];
      this.log(`could not decide on ${conversation.messageId}: ${decided.why ?? "unknown"}`);
      await reply(
        backend,
        conversation,
        agentId,
        words(langOf(conversation.text)).undecided(clip(decided.why ?? "unknown", 300)),
        this.log,
      );
      return "undecided";
    }
    const decision = decided.decision;
    delete state.attempts[key];
    // The session has had them.
    state.notices = [];
    this.log(`${conversation.messageId}: ${decision.kind} (${decision.reason})`);
    try {
      const acted = await act(
        { backend, agentId, policy: superagent, log: this.log },
        conversation,
        decision,
        workerRooms(superagent),
      );
      for (const [index, deployed] of acted.deployed.entries()) {
        state.tracked[deployed.taskId] = {
          room: deployed.room,
          conversation: {
            room: conversation.room,
            thread: conversation.thread,
            messageId: conversation.messageId,
            author: conversation.author,
            lang: langOf(conversation.text),
          },
          // A plan's steps are told only when they need the owner; the parent says when it is done.
          ...(decision.kind === "plan" && index > 0 ? { quiet: true } : {}),
        };
      }
      if (acted.reply !== "") await reply(backend, conversation, agentId, acted.reply, this.log);
    } catch (error) {
      this.log(
        `could not carry out ${decision.kind} for ${conversation.messageId}: ${describeError(error)}`,
      );
      await reply(
        backend,
        conversation,
        agentId,
        words(langOf(conversation.text)).failed(decision.kind, clip(describeError(error), 300)),
        this.log,
      );
    }
    return decision.kind;
  }

  /**
   * Follow every worker this superagent deployed, as a standing superagent
   * session follows its tickets: tell the owner when one finishes or blocks,
   * pass on at once a question a worker asks while it keeps working, decide
   * afresh what a worker handed back, and say once when its pull request merges
   * or closes.
   */
  private async follow(
    state: SuperagentState,
    superagent: SuperagentPolicy,
    worker: WorkerPolicy,
    signal?: AbortSignal,
  ): Promise<{ taskId: string; event: string }[]> {
    const { backend, agentId } = this.options;
    const told: { taskId: string; event: string }[] = [];
    const tell = async (
      taskId: string,
      tracked: Tracked,
      text: string,
      key: string,
    ): Promise<void> => {
      try {
        await reply(backend, { ...tracked.conversation }, agentId, text, this.log);
        told.push({ taskId, event: key });
        // The standing session hears of it on its next turn.
        state.notices = [...state.notices, clip(text.replace(/\s+/g, " "), 240)].slice(
          -MAX_NOTICES,
        );
      } catch (error) {
        this.log(`could not tell about ${taskId}: ${describeError(error)}`);
        throw error;
      }
    };
    for (const [taskId, tracked] of Object.entries(state.tracked)) {
      if (signal?.aborted === true) break;
      const detail = await backend
        .call<TaskDetail | null>("taskShow", { room: tracked.room, taskId })
        .catch(() => null);
      if (detail === null || detail === undefined) {
        delete state.tracked[taskId];
        continue;
      }
      const event = detail.events.at(-1);
      if (event === undefined) continue;

      // What the worker said in its thread: questions and handbacks.
      const messages = await backend
        .call<Message[]>("read", { room: tracked.room, thread: detail.thread })
        .catch(() => [] as Message[]);
      for (const message of Array.isArray(messages) ? messages : []) {
        if (Date.parse(message.header.ts) < Date.parse(state.since)) continue;
        const key = `msg:${message.header.id}`;
        if (state.noted[key] !== undefined) continue;
        const tags = message.header.tags;
        if (tags.includes(QUESTION_TAG) && message.header.needs === "human") {
          state.noted[key] = this.now();
          await tell(
            taskId,
            tracked,
            `Question from the worker on ${detail.task.title}:\n${clip(message.body, TOLD_CHARS)}\nAnswer here and I will pass it on.`,
            message.header.id,
          ).catch(() => delete state.noted[key]);
        } else if (tags.includes(HANDBACK_TAG)) {
          state.noted[key] = this.now();
          await this.handback(state, taskId, tracked, detail, message, superagent, worker, signal);
        }
      }

      if (tracked.told !== event.messageId) {
        const text = toldText(detail, tracked.quiet === true, tracked.conversation.lang ?? "en");
        tracked.told = event.messageId;
        if (event.action === "completed") {
          const pr = prUrlsIn(event.refs)[0];
          if (pr !== undefined) tracked.pr = pr;
        }
        if (text !== null) {
          await tell(taskId, tracked, text, event.messageId).catch(() => delete tracked.told);
        }
      }

      if (tracked.pr !== undefined && tracked.prDone !== true) {
        await this.followPr(taskId, tracked, superagent, tell);
      }

      const ended = detail.task.state === "completed" || detail.task.state === "cancelled";
      // An open pull request is followed longer, until it merges or closes.
      const days =
        tracked.pr !== undefined && tracked.prDone !== true ? PR_FOLLOW_DAYS : FOLLOW_DAYS;
      const old = this.now() - Date.parse(event.ts) > days * 86_400_000;
      const prSettled = tracked.pr === undefined || tracked.prDone === true;
      if (ended && (old || (prSettled && tracked.pr !== undefined))) delete state.tracked[taskId];
    }
    return told;
  }

  /** Ask the GitHub CLI about a worker's pull request, at most every few minutes. */
  private async followPr(
    taskId: string,
    tracked: Tracked,
    superagent: SuperagentPolicy,
    tell: (taskId: string, tracked: Tracked, text: string, key: string) => Promise<void>,
  ): Promise<void> {
    const url = tracked.pr as string;
    if (this.now() - (tracked.prCheckedAt ?? 0) < PR_CHECK_MS) return;
    tracked.prCheckedAt = this.now();
    let view: { state: string };
    try {
      const stdout = await (this.options.gh ?? execGh)(
        [superagent.big.githubCli, "pr", "view", url, "--json", "state,mergedAt,closedAt,url"],
        { timeoutMs: GH_TIMEOUT_MS },
      );
      view = parsePrView(stdout);
    } catch (error) {
      this.log(`could not check ${url}: ${describeError(error)}`);
      return;
    }
    if (view.state === "OPEN") return;
    tracked.prDone = true;
    const text =
      view.state === "MERGED"
        ? words(tracked.conversation.lang ?? "en").merged(url)
        : words(tracked.conversation.lang ?? "en").closed(url);
    await tell(taskId, tracked, text, `pr:${url}`).catch(() => delete tracked.prDone);
  }

  /**
   * A worker handed a request back as beyond its task. It is decided afresh, as
   * a standing superagent session decides a handed-back trigger: new work,
   * another worker, an answer, or nothing; never back to the same worker.
   */
  private async handback(
    state: SuperagentState,
    taskId: string,
    tracked: Tracked,
    detail: TaskDetail,
    message: Message,
    superagent: SuperagentPolicy,
    worker: WorkerPolicy,
    signal?: AbortSignal,
  ): Promise<void> {
    const { backend, agentId } = this.options;
    const work = workRoom(superagent);
    const conversation: Conversation = {
      ...tracked.conversation,
      text: `The worker on task ${taskId} (${detail.task.title}) handed this back as beyond its task: ${clip(message.body, 1500)}`,
      context: [],
    };
    const decided = await decide(conversation, {
      backend,
      worker,
      role: "big",
      kinds: BIG_KINDS,
      self: agentId,
      timeoutSeconds: superagent.big.timeoutSeconds,
      rooms: workerRooms(superagent),
      defaultRoom: work,
      related: new Set([taskId]),
      now: this.now(),
      ...(superagent.big.runner === undefined ? {} : { runner: superagent.big.runner }),
      ...(this.options.ask === undefined ? {} : { ask: this.options.ask }),
      ...(this.mind === undefined ? {} : { mind: this.mind }),
      ...(signal === undefined ? {} : { signal }),
    });
    let decision = decided.decision;
    if (decision !== null && decision.kind === "attach" && decision.taskId === taskId)
      decision = null;
    if (decision === null) {
      await reply(
        backend,
        conversation,
        agentId,
        `The worker on ${detail.task.title} handed something back that I could not place:\n${clip(message.body, TOLD_CHARS)}`,
        this.log,
      ).catch(() => undefined);
      return;
    }
    try {
      const acted = await act(
        { backend, agentId, policy: superagent, log: this.log },
        conversation,
        decision,
        workerRooms(superagent),
      );
      for (const deployed of acted.deployed) {
        state.tracked[deployed.taskId] = {
          room: deployed.room,
          conversation: tracked.conversation,
        };
      }
      if (acted.reply !== "") await reply(backend, conversation, agentId, acted.reply, this.log);
    } catch (error) {
      this.log(`handback ${message.header.id} failed: ${describeError(error)}`);
    }
  }

  /**
   * Act on what the small superagents report, and on workers nobody picked up.
   *
   * Each situation is decided once. The decision may move the worker, stop
   * it, or tell the owner; telling goes to the conversation that deployed it.
   */
  private async coordinate(
    state: SuperagentState,
    superagent: SuperagentPolicy,
    worker: WorkerPolicy,
    signal?: AbortSignal,
  ): Promise<{ key: string; decision: RouteDecision["kind"] | "undecided" }[]> {
    const { backend, agentId } = this.options;
    const work = workRoom(superagent);
    const situations: { key: string; taskId: string; author: string; text: string }[] = [];
    const messages = await backend
      .call<Message[]>("read", { room: work })
      .catch(() => [] as Message[]);
    const byThread = new Map<string, string>();
    for (const [taskId, tracked] of Object.entries(state.tracked)) {
      const detail = await backend
        .call<TaskDetail | null>("taskShow", { room: tracked.room, taskId })
        .catch(() => null);
      if (detail === null || detail === undefined) continue;
      byThread.set(detail.thread, taskId);
      const waiting = this.now() - Date.parse(detail.events[0]?.ts ?? detail.updatedAt);
      if (
        detail.task.state === "open" &&
        detail.task.target !== undefined &&
        waiting > UNCLAIMED_MINUTES * 60_000
      ) {
        situations.push({
          key: `unclaimed:${taskId}`,
          taskId,
          author: agentId,
          text: `Task ${taskId} (${detail.task.title}) has waited ${String(Math.round(waiting / 60_000))} minutes for ${detail.task.target} and nobody has picked it up.`,
        });
      }
    }
    for (const message of messages) {
      if (!message.header.tags.includes(SMALL_REPORT_TAG)) continue;
      if (Date.parse(message.header.ts) < Date.parse(state.since)) continue;
      const taskId = byThread.get(message.header.thread);
      if (taskId === undefined) continue;
      situations.push({
        key: `report:${message.header.id}`,
        taskId,
        author: message.header.from,
        text: `Report on task ${taskId}: ${clip(message.body, 500)}`,
      });
    }

    const done: { key: string; decision: RouteDecision["kind"] | "undecided" }[] = [];
    for (const situation of situations) {
      if (done.length >= MAX_COORDINATION_PER_PASS || signal?.aborted === true) break;
      if (state.noted[situation.key] !== undefined) continue;
      state.noted[situation.key] = this.now();
      const tracked = state.tracked[situation.taskId];
      if (tracked === undefined) continue;
      const conversation: Conversation = {
        room: tracked.conversation.room,
        thread: tracked.conversation.thread,
        messageId: tracked.conversation.messageId,
        author: tracked.conversation.author,
        text: situation.text,
        context: [],
      };
      const decided = await decide(
        { text: situation.text, author: situation.author, context: [] },
        {
          backend,
          worker,
          role: "coordinator",
          kinds: COORDINATOR_KINDS,
          self: agentId,
          timeoutSeconds: superagent.big.timeoutSeconds,
          rooms: workerRooms(superagent),
          defaultRoom: work,
          related: new Set([situation.taskId]),
          now: this.now(),
          ...(superagent.big.runner === undefined ? {} : { runner: superagent.big.runner }),
          ...(this.options.ask === undefined ? {} : { ask: this.options.ask }),
          ...(this.mind === undefined ? {} : { mind: this.mind }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (decided.decision === null) {
        this.log(`could not coordinate ${situation.key}: ${decided.why ?? "unknown"}`);
        done.push({ key: situation.key, decision: "undecided" });
        continue;
      }
      try {
        const acted = await act(
          { backend, agentId, policy: superagent, log: this.log },
          conversation,
          decided.decision,
          workerRooms(superagent),
        );
        if (acted.reply !== "") await reply(backend, conversation, agentId, acted.reply, this.log);
      } catch (error) {
        this.log(`coordination ${situation.key} failed: ${describeError(error)}`);
      }
      done.push({ key: situation.key, decision: decided.decision.kind });
    }
    // Forget situations older than a week.
    for (const [key, at] of Object.entries(state.noted)) {
      if (this.now() - at > FOLLOW_DAYS * 86_400_000) delete state.noted[key];
    }
    return done;
  }
}

/** The runner a superagent thinks with, or undefined when none is allowed (decide says why). */
export function thinkerOf(
  worker: WorkerPolicy,
  requested: string | undefined,
): ReturnType<typeof resolveThinker> | undefined {
  try {
    return resolveThinker(worker, requested);
  } catch {
    return undefined;
  }
}
