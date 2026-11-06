/**
 * Follow-ups: a person's later message on a task this worker ran (ADR 0030 §5).
 *
 * Intake relays a person's message from the chat into the task's oguri thread,
 * with an `external` header that says a person wrote it. When such a message
 * reaches a task this agent ran on this machine, the worker runs the task
 * again: in the same directory, and in the same agent session when the runner
 * can resume one.
 *
 * The rules are pure functions over messages, run records, and the task, so
 * which message wakes which task is testable without a backend.
 */

import {
  describeError,
  findTier,
  type RunnerGate,
  type TaskDetail,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { EXTERNAL_CONTEXT_TAG, type Message, type Task } from "@oguri/protocol";

import type { ThreadLine } from "./prompt.ts";
import { listRuns, readConsumed, type RunRecord } from "./runs.ts";
import {
  effortSourceOf,
  parseRunnerHint,
  resolveRunner,
  type Candidate,
  type Skipped,
} from "./select.ts";

const DAY_MS = 24 * 60 * 60_000;
/** One message is cut to this in a prompt; the whole text stays in the thread. */
const LINE_LIMIT = 4 * 1024;

/** How the worker takes a task back for a follow-up, decided from the task alone. */
export type Retake =
  /** Open again: claim it, then start it. */
  | "claim"
  /** Still held by this agent and not running: start it. */
  | "start"
  /** In progress under this agent already, e.g. waiting for subtasks: just run. */
  | "continue"
  /** Completed, and this agent created it: reopen, claim, start. */
  | "reopen"
  /**
   * Completed by this agent, which did not create it. Only the creator may
   * reopen a task, so the worker answers in the thread and the task stays
   * completed.
   */
  | "reply";

/** A follow-up the worker will run. */
export interface Followup {
  task: Task;
  retake: Retake;
  /** This task's latest local run, whose directory and session the follow-up reuses. */
  previous: RunRecord;
  /** The person's new messages, oldest first. */
  messages: ThreadLine[];
  /** The thread as an agent reads it: people's messages and this worker's replies. */
  conversation: ThreadLine[];
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= LINE_LIMIT ? trimmed : `${trimmed.slice(0, LINE_LIMIT)}…`;
}

function lineOf(message: Message, agentId: string): ThreadLine {
  const external = message.header.external;
  // A person's words relayed by this agent are theirs, not "you".
  const author =
    external !== undefined
      ? (external.actorName ?? external.actor)
      : message.header.from === agentId
        ? "you"
        : message.header.from;
  return { id: message.header.id, ts: message.header.ts, author, body: clip(message.body) };
}

/**
 * A person's message relayed from outside, written by someone other than this
 * agent, from someone intake admitted. A message intake tagged as context came
 * from a person who may not start work, so it never starts a run; a resumed
 * run still reads it as part of the conversation.
 */
export function isHumanFollowup(
  message: Message,
  agentId: string,
  trusted?: (author: string) => boolean,
): boolean {
  // This agent's own relay counts too: a superagent or intake running as the
  // same identity as the worker writes a person's words into the thread. The
  // worker's own replies never carry `external`, so they are never taken.
  void agentId;
  return (
    message.header.external?.human === true &&
    !message.header.tags.includes(EXTERNAL_CONTEXT_TAG) &&
    (trusted === undefined || trusted(message.header.from))
  );
}

/**
 * Who may speak for a person in a task's thread.
 *
 * The `external` header says who wrote a message, not who relayed it, and any
 * member of the transport repository can write one. A follow-up starts a run
 * without the claim and approval gates, so only the task's creator (intake,
 * for a task asked for in a chat) or an agent in `worker.trustedRequesters`
 * counts. Everyone else's messages stay in the thread as plain messages.
 */
export function followupAuthors(
  creator: string,
  trustedRequesters: readonly string[],
  self?: string,
): (author: string) => boolean {
  return (author) => author === creator || author === self || trustedRequesters.includes(author);
}

/**
 * New messages from a person in one task thread.
 *
 * "New" is after the start of this task's latest local run, and not already
 * handed to a run. A message that arrived during a run waits for the run to
 * end; the caller never asks while one is in flight.
 */
export function pendingMessages(
  messages: readonly Message[],
  options: { thread: string; agentId: string; since: string; consumed: ReadonlySet<string> },
): Message[] {
  const since = Date.parse(options.since);
  return messages.filter(
    (message) =>
      message.header.thread === options.thread &&
      isHumanFollowup(message, options.agentId) &&
      Date.parse(message.header.ts) > since &&
      !options.consumed.has(message.header.id),
  );
}

/** The thread as context for a run: what people said and what this worker answered. */
export function conversationOf(
  messages: readonly Message[],
  thread: string,
  agentId: string,
  trusted?: (author: string) => boolean,
): ThreadLine[] {
  return messages
    .filter(
      (message) =>
        message.header.thread === thread &&
        (isHumanFollowup(message, agentId, trusted) ||
          (message.header.from === agentId &&
            (message.header.relay !== undefined ||
              message.header.task?.action === "completed" ||
              message.header.task?.action === "blocked"))),
    )
    .map((message) => lineOf(message, agentId));
}

export function threadLines(messages: readonly Message[], agentId: string): ThreadLine[] {
  return messages.map((message) => lineOf(message, agentId));
}

/**
 * How to take the task back, or why not.
 *
 * Cancelled is final: the creator withdrew the work. A task held by someone
 * else is theirs. A completed task is taken back only within `followupDays`
 * of its completion, and only if this agent completed it.
 */
export function retakeFor(
  detail: Pick<TaskDetail, "task" | "events">,
  agentId: string,
  followupDays: number,
  now: number,
): Retake | { skip: string } {
  const task = detail.task;
  // Reopened or open with no claim left, the task would sit open with nobody
  // allowed to take it; its creator has to decide.
  const noAttempt =
    task.maxAttempts !== undefined && (task.attempt ?? 0) >= task.maxAttempts
      ? { skip: `all ${String(task.maxAttempts)} attempt(s) are used` }
      : null;
  switch (task.state) {
    case "cancelled":
      return { skip: "the task was cancelled" };
    case "open":
      return noAttempt ?? "claim";
    case "completed": {
      if (task.assignee !== agentId)
        return { skip: `the task was completed by ${task.assignee ?? "someone else"}` };
      const completed = [...detail.events].reverse().find((event) => event.action === "completed");
      const at = completed === undefined ? Number.NaN : Date.parse(completed.ts);
      if (followupDays === 0 || !Number.isFinite(at) || now - at > followupDays * DAY_MS) {
        return {
          skip: `the task completed more than worker.followupDays (${String(followupDays)}) ago`,
        };
      }
      if (task.creator !== agentId) return "reply";
      return noAttempt ?? "reopen";
    }
    default:
      if (task.assignee !== agentId)
        return { skip: `the task is held by ${task.assignee ?? "nobody"}` };
      return task.state === "in_progress" ? "continue" : "start";
  }
}

/** The latest local run of each task, newest first. */
export function latestRuns(records: readonly RunRecord[]): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const record of records) {
    const known = latest.get(record.taskId);
    if (known === undefined || record.startedAt > known.startedAt)
      latest.set(record.taskId, record);
  }
  return [...latest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Which tasks are worth reading the room for.
 *
 * A task whose latest run is older than `followupDays` and that is not still
 * on the agenda cannot qualify, so its room is not read for it. Records
 * written before threads were recorded cannot be matched and are left out.
 */
export function watchedRuns(
  records: readonly RunRecord[],
  options: {
    active: ReadonlySet<string>;
    exclude: ReadonlySet<string>;
    followupDays: number;
    now: number;
  },
): RunRecord[] {
  return latestRuns(records).filter((record) => {
    if (record.thread === undefined || options.exclude.has(record.taskId)) return false;
    if (record.outcome === "running") return false;
    if (options.active.has(record.taskId)) return true;
    const ended = Date.parse(record.finishedAt ?? record.startedAt);
    return options.followupDays > 0 && options.now - ended <= options.followupDays * DAY_MS;
  });
}

/** Read each room once, whatever number of watched tasks it holds. */
async function readRooms(
  backend: Backend,
  rooms: Iterable<string>,
  log: (key: string, line: string) => void,
): Promise<Map<string, Message[]>> {
  const read = new Map<string, Message[]>();
  for (const room of new Set(rooms)) {
    try {
      const messages = await backend.call<Message[]>("read", { room });
      read.set(room, Array.isArray(messages) ? messages : []);
    } catch (error) {
      log(`read:${room}`, `could not read ${room} for follow-ups: ${describeError(error)}`);
    }
  }
  return read;
}

/** A follow-up, with the runner it runs under. */
export interface FollowupJob {
  candidate: Candidate;
  followup: Followup;
}

export interface FollowupOptions {
  backend: Backend;
  agentId: string;
  home: string;
  policy: WorkerPolicy;
  /** Tasks on this pass's agenda: unfinished work that is watched whatever its age. */
  active: ReadonlySet<string>;
  /** Tasks with a run in flight here, or settled by recovery this pass. */
  exclude: ReadonlySet<string>;
  now: number;
  /** Log a line once per key. */
  note: (key: string, line: string) => void;
  /** Which runners may be used here beyond the allow-list (ADR 0034). */
  gate?: RunnerGate;
}

/**
 * Find the follow-ups to run now.
 *
 * Reads the rooms of watched tasks once each, and a task's detail only when
 * a person has written something new in its thread. A task that cannot be
 * taken back is reported once per newest message, not on every pass.
 */
export async function findFollowups(
  options: FollowupOptions,
): Promise<{ jobs: FollowupJob[]; skipped: Skipped[] }> {
  const { backend, agentId, home, policy, note } = options;
  const watched = watchedRuns(await listRuns(home, Number.POSITIVE_INFINITY), {
    active: options.active,
    exclude: options.exclude,
    followupDays: policy.followupDays,
    now: options.now,
  });
  const jobs: FollowupJob[] = [];
  const skipped: Skipped[] = [];
  if (watched.length === 0) return { jobs, skipped };
  const rooms = await readRooms(
    backend,
    watched.map((record) => record.room),
    note,
  );

  for (const previous of watched) {
    const messages = rooms.get(previous.room);
    const thread = previous.thread as string;
    if (messages === undefined) continue;
    const fresh = pendingMessages(messages, {
      thread,
      agentId,
      since: previous.followupSince ?? previous.startedAt,
      consumed: await readConsumed(home, previous.taskId),
    });
    if (fresh.length === 0) continue;
    const skip = (reason: string): void => {
      note(
        `followup:${previous.taskId}:${(fresh.at(-1) as Message).header.id}`,
        `${previous.taskId} follow-up not run: ${reason}`,
      );
      skipped.push({ room: previous.room, taskId: previous.taskId, reason });
    };

    let detail: TaskDetail;
    try {
      detail = await backend.call<TaskDetail>("taskShow", {
        room: previous.room,
        taskId: previous.taskId,
      });
    } catch (error) {
      skip(`the task could not be read: ${describeError(error)}`);
      continue;
    }
    // A person in the chat may be anyone intake admitted (ADR 0030 §4), but
    // only intake, the task's creator, may relay them. A message written by
    // anyone else is not a follow-up, whatever its `external` header claims.
    const trusted = followupAuthors(detail.task.creator, policy.trustedRequesters, agentId);
    const accepted = fresh.filter((message) => isHumanFollowup(message, agentId, trusted));
    if (accepted.length === 0) {
      skip(`no message in the thread was relayed by ${detail.task.creator} or a trusted requester`);
      continue;
    }
    const retake = retakeFor(detail, agentId, policy.followupDays, options.now);
    if (typeof retake === "object") {
      skip(retake.skip);
      continue;
    }
    // The runner of the earlier run, so the session and directory match. Its
    // argv still comes from this machine's policy, never from the record. The
    // task's effort hint is re-read and re-checked against the allow-list, so a
    // follow-up runs at the same level. An unlisted level is ignored here: the
    // first run already reported it, and a follow-up must not be dropped for it.
    //
    // A person's newest message may name its own level on its first line
    // (`effort: high`), for this run only (ADR 0034). It is checked against the
    // same allow-list, and a level that is not on it is said once rather than
    // silently replaced.
    const hint = parseRunnerHint(detail.definition);
    const newest = accepted.at(-1) as Message;
    const asked = followupEffort(newest.body);
    // The level the task itself runs at: its own line, else its tier's, when
    // the earlier run's runner is in that tier.
    const tier = hint.tier === undefined ? undefined : findTier(policy, hint.tier);
    const tierEffort = tier?.runners.includes(previous.runner) === true ? tier.effort : undefined;
    const taskEffort = hint.effort ?? tierEffort;
    const listed = policy.runners[previous.runner]?.efforts ?? [];
    const own = asked.effort !== undefined && listed.includes(asked.effort);
    if (asked.effort !== undefined && !own) {
      note(
        `followup-effort:${newest.header.id}`,
        `${previous.taskId} follow-up effort '${asked.effort}' is not allowed for this runner (allowed: ${listed.join(", ") || "none"}); running at the task's level`,
      );
    }
    const resolved = resolveRunner(
      policy,
      previous.runner,
      own ? asked.effort : taskEffort,
      options.gate,
    );
    if ("error" in resolved) {
      skip(resolved.error);
      continue;
    }
    if (own && resolved.conflictedEffort !== undefined) {
      note(
        `followup-effort:${newest.header.id}`,
        `${previous.taskId} follow-up ${resolved.conflictedEffort}`,
      );
    }
    const source = effortSourceOf(
      own ? asked.effort : taskEffort,
      resolved,
      own ? "follow-up" : hint.effort === undefined ? "tier" : "task",
    );
    const task = detail.task;
    const lines = threadLines(accepted, agentId);
    // The hint is for the worker, not the agent: the run reads the message without it.
    if (asked.effort !== undefined) {
      const last = lines.at(-1);
      if (last !== undefined) last.body = asked.text;
    }
    jobs.push({
      candidate: {
        room: previous.room,
        taskId: task.id,
        title: task.title,
        creator: task.creator,
        prompt: hint.prompt,
        runner: resolved.name,
        argv: resolved.argv,
        ...(hint.tier === undefined ? {} : { tier: hint.tier }),
        ...(hint.tierReason === undefined ? {} : { tierReason: hint.tierReason }),
        ...(hint.escalated === undefined ? {} : { escalated: hint.escalated }),
        ...source,
        ...(resolved.workdir === undefined ? {} : { workdir: resolved.workdir }),
        worktree: resolved.worktree,
        ...(resolved.resume === undefined ? {} : { resume: resolved.resume }),
        ...(resolved.session === undefined ? {} : { session: resolved.session }),
        thread,
        ...(task.origin === undefined ? {} : { origin: task.origin }),
        relation: "followup",
        attempt: task.attempt ?? 0,
        ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
        ...(task.parent === undefined ? {} : { parent: task.parent }),
        ...(task.dependsOn === undefined || task.dependsOn.length === 0
          ? {}
          : { dependsOn: [...task.dependsOn] }),
        priority: detail.priority,
      },
      followup: {
        task,
        retake,
        previous,
        messages: lines,
        conversation: conversationOf(messages, thread, agentId, trusted),
      },
    });
  }
  return { jobs, skipped };
}

/**
 * A follow-up's own `effort: <level>` first line, and the message without it.
 *
 * Only `effort:` is read here. A follow-up continues the task's session, so it
 * keeps the runner that session belongs to; a `runner:` or `tier:` line in a
 * person's message is just text. The level is still only a request: the
 * runner's `efforts` list decides whether it is used.
 */
export function followupEffort(body: string): { effort?: string; text: string } {
  const hint = parseRunnerHint(body);
  if (hint.effort === undefined || hint.runner !== undefined || hint.tier !== undefined) {
    return { text: body };
  }
  return { effort: hint.effort, text: hint.prompt };
}
