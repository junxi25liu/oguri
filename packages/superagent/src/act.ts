/**
 * How a superagent decides, and what it does with the decision (ADR 0031).
 *
 * `decide` shows a model what the transport repository says about the
 * machines and workers, and checks its reply in code. `act` turns a checked
 * decision into writes every agent can read: deploy a worker (create a task
 * for a machine), pass a message to a worker (a follow-up its session
 * continues with), move or stop a worker, or reply in the conversation.
 */

import { createHash } from "node:crypto";

import {
  createPlanTasks,
  describeError,
  renderTaskHeader,
  type RunnerGate,
  type SuperagentPolicy,
  type TaskDetail,
  type TaskStatus,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message, TaskMandate } from "@oguri/protocol";

import {
  parseRouteDecision,
  RouteError,
  type RouteDecision,
  type RouteKind,
  type RouteTier,
} from "./decision.ts";
import { OneShotMind, type Mind } from "./mind.ts";
import { askModel, resolveThinker, type AskModel } from "./model.ts";
import {
  buildReadTurn,
  buildRetryTurn,
  buildRules,
  buildTurn,
  type RouteRequest,
  type SuperagentRole,
} from "./prompt.ts";
import {
  loadSnapshot,
  scopeOf,
  tierScope,
  type Snapshot,
  type SnapshotOptions,
} from "./snapshot.ts";
import { langOf, words } from "./words.ts";

/** What every plan step's worker is told after its step. */
export const PLAN_STEP_NOTE =
  "This is one step of a larger plan; other workers do the other steps at the same time. Do only this step, and touch only what it needs. The owner's whole request is on the plan's parent task.";

/** At most this many workers from one request. */
export const MAX_ROUTE_STEPS = 8;

/** Tag on everything a superagent writes in a conversation, so it never answers itself. */
export const FROM_SUPERAGENT_TAG = "from-superagent";
/** Tag on a message for the big superagent. */
export const TO_BIG_TAG = "to-big";
/** Tag on a message for a small superagent; it also mentions that agent. */
export const TO_SMALL_TAG = "to-small";
/** Tag on a small superagent's report about one of its workers. */
export const SMALL_REPORT_TAG = "superagent-small";

/** Tag on a request that a person authorize a runner (`request_runner`). */
export const RUNNER_REQUEST_TAG = "runner-request";

export const BIG_KINDS: readonly RouteKind[] = [
  "read",
  "accept",
  "plan",
  "attach",
  "retarget",
  "relink",
  "replace",
  "request_runner",
  "answer",
  "clarify",
  "stop",
  "ignore",
];
/** A small superagent decides how many workers its machine runs: one, or a plan of several. */
export const SMALL_KINDS: readonly RouteKind[] = [
  "read",
  "accept",
  "plan",
  "attach",
  "answer",
  "clarify",
  "stop",
  "ignore",
];
export const COORDINATOR_KINDS: readonly RouteKind[] = [
  "read",
  "retarget",
  "relink",
  "replace",
  "request_runner",
  "stop",
  "answer",
  "ignore",
];

/** Rounds of reading before a superagent must decide. */
export const MAX_READ_ROUNDS = 2;
const DETAIL_EVENTS = 12;
const DETAIL_CHARS = 600;

/** One message a superagent was asked to act on. */
export interface Conversation extends RouteRequest {
  room: string;
  messageId: string;
  thread: string;
}

export interface DecideOptions {
  backend: Backend;
  worker: WorkerPolicy;
  role: SuperagentRole;
  kinds: readonly RouteKind[];
  self: string;
  machine?: string;
  runner?: string;
  timeoutSeconds: number;
  rooms: readonly string[];
  defaultRoom: string;
  related?: ReadonlySet<string>;
  only?: SnapshotOptions["only"];
  /** Where a worker goes when the decision names no target. */
  defaultTarget?: string;
  /** How many workers the machine a small superagent speaks for runs at once. */
  maxWorkers?: number;
  now: number;
  ask?: AskModel;
  /** The superagent's standing session (ADR 0033); without it, one call per turn. */
  mind?: Mind;
  /** What happened since the last turn, already told to the owner. */
  notices?: readonly string[];
  /** Which runners a worker may be deployed on beyond the allow-list (ADR 0034). */
  gate?: RunnerGate;
  signal?: AbortSignal;
}

export interface Decided {
  decision: RouteDecision | null;
  /** Why there is no decision, for the log and the owner. Our own words, never the model's. */
  why?: string;
  /** The model did not answer: worth asking again later, as a requeued evaluation. */
  retry?: boolean;
  snapshot: Snapshot;
}

export async function decide(request: RouteRequest, options: DecideOptions): Promise<Decided> {
  const snapshot = await loadSnapshot(options.backend, {
    rooms: options.rooms,
    now: options.now,
    ...(options.related === undefined ? {} : { related: options.related }),
    ...(options.only === undefined ? {} : { only: options.only }),
  });
  // Only a role that deploys workers chooses their runners (ADR 0034).
  const deploys = options.kinds.includes("accept") || options.kinds.includes("plan");
  const choices = deploys ? tierScope(options.worker, options.gate) : undefined;
  if (choices !== undefined) snapshot.choices = choices;
  const scope = scopeOf(snapshot, {
    kinds: options.kinds,
    mayAnswer: options.kinds.includes("answer"),
    maxSteps: MAX_ROUTE_STEPS,
    ...(options.defaultTarget === undefined ? {} : { defaultTarget: options.defaultTarget }),
    ...(choices === undefined ? {} : { tiers: choices }),
  });
  try {
    const runner = resolveThinker(options.worker, options.runner);
    const mind = options.mind ?? new OneShotMind(runner, options.ask ?? askModel);
    const inSession = mind.kind !== "none";
    const rules = buildRules({
      role: options.role,
      kinds: options.kinds,
      allKinds: options.role === "small" ? SMALL_KINDS : BIG_KINDS,
      self: options.self,
      defaultRoom: options.defaultRoom,
      maxSteps: MAX_ROUTE_STEPS,
      ...(options.machine === undefined ? {} : { machine: options.machine }),
      ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
    });
    // The last round may not read again: it decides with what it has.
    const kindsFor = (round: number): readonly RouteKind[] =>
      round >= MAX_READ_ROUNDS ? options.kinds.filter((kind) => kind !== "read") : options.kinds;
    let details: string | undefined;
    /** A short follow-up turn for a session that already has the message. */
    let followUp: string | undefined;
    let corrected = false;
    for (let round = 0; ; round += 1) {
      const kinds = kindsFor(round);
      const turn =
        followUp !== undefined && (await mind.primed(rules))
          ? followUp
          : buildTurn(
              request,
              snapshot,
              {
                role: options.role,
                kinds,
                ...(options.notices === undefined ? {} : { notices: options.notices }),
              },
              details,
            );
      followUp = undefined;
      const result = await mind.turn({
        rules,
        turn,
        timeoutMs: options.timeoutSeconds * 1000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!result.ok) {
        return {
          decision: null,
          why: `the model did not answer (${result.error ?? "failed"})`,
          retry: true,
          snapshot,
        };
      }
      let decision: RouteDecision;
      try {
        decision = parseRouteDecision(result.stdout, { ...scope, kinds });
      } catch (error) {
        // A session is told why and decides once more, as a tool call that
        // fails its schema is answered with the error.
        if (!(error instanceof RouteError) || !inSession || corrected) throw error;
        corrected = true;
        followUp = buildRetryTurn(error.message, kinds);
        round -= 1;
        continue;
      }
      if (decision.kind !== "read") return { decision, snapshot };
      const read = await readDetails(options.backend, snapshot, decision.taskIds);
      details = details === undefined ? read : `${details}\n\n${read}`;
      if (inSession) followUp = buildReadTurn(read, kindsFor(round + 1));
    }
  } catch (error) {
    const why = error instanceof RouteError ? error.message : describeError(error);
    return { decision: null, why, snapshot };
  }
}

/** Tasks' full history, as a superagent reads it before deciding. */
export async function readDetails(
  backend: Backend,
  snapshot: Snapshot,
  taskIds: readonly string[],
): Promise<string> {
  const parts: string[] = [];
  for (const taskId of taskIds) {
    const room = snapshot.tasks.find((task) => task.id === taskId)?.room;
    if (room === undefined) continue;
    const detail = await backend
      .call<TaskDetail | null>("taskShow", { room, taskId })
      .catch(() => null);
    if (detail === null || detail === undefined) continue;
    const events = detail.events.slice(-DETAIL_EVENTS).map((event) => {
      const refs = event.refs.length === 0 ? "" : ` (refs: ${event.refs.join(", ")})`;
      return `- ${event.ts} ${event.from} ${event.action}: ${clipText(event.body, DETAIL_CHARS)}${refs}`;
    });
    parts.push(
      [
        `Task ${taskId}: ${detail.task.title} [${detail.task.state}, ${detail.health}]`,
        `Definition: ${clipText(detail.definition, DETAIL_CHARS * 2)}`,
        ...events,
      ].join("\n"),
    );
  }
  return parts.length === 0 ? "(none of those tasks could be read)" : parts.join("\n\n");
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The mandate a superagent's task carries: who decided, and under which policy. */
export function superagentMandate(policy: SuperagentPolicy): TaskMandate {
  const material = JSON.stringify({ big: policy.big, small: { big: policy.small.big ?? null } });
  return {
    strength: "explicit",
    via: "router",
    policy: createHash("sha256").update(material).digest("hex").slice(0, 16),
  };
}

/**
 * A worker's task text: the runner header when the decision chose one, then
 * the owner's words verbatim, then any routing note.
 *
 * The header is written by code from a checked choice, never by the model: a
 * tier, runner, and effort the decision was allowed to name, and the reason in
 * one line. The owner's own text starts after a blank line, so nothing in it
 * can be read as another header line.
 */
export function taskDefinition(text: string, note?: string, choice?: RouteTier): string {
  const routed =
    note === undefined || note.trim() === ""
      ? ""
      : `\n\nRouting note from the superagent: ${note.trim()}`;
  return `${headerOf(choice)}${text.trim()}${routed}`;
}

/** The header lines for a checked choice, or nothing when there is none. */
export function headerOf(choice: RouteTier | undefined): string {
  if (choice === undefined) return "";
  return renderTaskHeader({
    ...(choice.runner === undefined ? {} : { runner: choice.runner }),
    ...(choice.effort === undefined ? {} : { effort: choice.effort }),
    ...(choice.tier === undefined ? {} : { tier: choice.tier }),
    ...(choice.reason === "" ? {} : { reason: choice.reason }),
  });
}

export interface ActContext {
  backend: Backend;
  agentId: string;
  policy: SuperagentPolicy;
  /** Where a worker goes when the decision names no machine. */
  defaultTarget?: string;
  /**
   * Claims a worker on a tier gets, so a failed run is released for another
   * try and may move up a tier (ADR 0034). See `escalationAttempts`.
   */
  maxAttempts?: number;
  log: (line: string) => void;
}

/**
 * How many tries a tiered worker gets: one, plus one for every tier it may
 * climb under this machine's `worker.escalation`. Without escalation there is
 * no limit to set, and a failed run blocks as before.
 */
export function escalationAttempts(worker: Pick<WorkerPolicy, "escalation">): number | undefined {
  return worker.escalation.maxSteps > 0 ? worker.escalation.maxSteps + 1 : undefined;
}

/** What acting did. `deployed` lists the tasks whose workers were deployed. */
export interface Acted {
  reply: string;
  deployed: { room: string; taskId: string }[];
}

async function findTask(
  backend: Backend,
  rooms: readonly string[],
  taskId: string,
): Promise<{ room: string; detail: TaskDetail }> {
  for (const room of rooms) {
    const detail = await backend
      .call<TaskDetail | null>("taskShow", { room, taskId })
      .catch(() => null);
    if (detail !== null && detail !== undefined) return { room, detail };
  }
  throw new Error(`task ${taskId} is not in ${rooms.join(", ")}`);
}

function where(target: string | undefined, requires: readonly string[]): string {
  if (target !== undefined) return target;
  return `any machine with ${requires.join(", ")}`;
}

export async function act(
  context: ActContext,
  conversation: Conversation,
  decision: RouteDecision,
  rooms: readonly string[],
): Promise<Acted> {
  const { backend } = context;
  const mandate = superagentMandate(context.policy);
  const say = words(langOf(conversation.text));
  switch (decision.kind) {
    case "accept": {
      const target = decision.target ?? context.defaultTarget;
      const created = await backend.call<Message>("taskCreate", {
        room: decision.room,
        input: {
          title: decision.title,
          definition: taskDefinition(conversation.text, decision.note, decision.choice),
          mandate,
          ...(target === undefined ? {} : { target }),
          ...(decision.requires.length === 0 ? {} : { requires: decision.requires }),
          // Only a worker on a tier climbs; a pinned runner keeps the default rules.
          ...(context.maxAttempts === undefined || decision.choice?.tier === undefined
            ? {}
            : { maxAttempts: context.maxAttempts }),
        },
      });
      const taskId = created.header.task?.id ?? created.header.id;
      return {
        reply: `${decision.acknowledgement}\n${say.deployedOne(where(target, decision.requires), taskId)}\n${say.follow}`,
        deployed: [{ room: decision.room, taskId }],
      };
    }
    case "plan": {
      const created = await createPlanTasks(
        {
          createTask: async (room, input) =>
            await backend.call<Message>("taskCreate", {
              room,
              input: input.parent === undefined ? { ...input, mandate } : input,
            }),
          claimTask: async (room, taskId, body) =>
            await backend.call<Message>("taskClaim", { room, taskId, body }),
        },
        decision.room,
        {
          title: decision.title,
          tasks: decision.steps.map((step) => ({
            key: step.key,
            title: step.title,
            // One step of a plan: the step alone. The owner's whole request, with
            // every other step in it, would invite the worker to do those too.
            body: `${headerOf(step.choice)}${step.body.trim()}\n\n${PLAN_STEP_NOTE}`,
            dependsOn: step.dependsOn,
            requires: step.requires,
            ...(context.maxAttempts === undefined || step.choice?.tier === undefined
              ? {}
              : { maxAttempts: context.maxAttempts }),
            ...((step.target ?? context.defaultTarget) === undefined
              ? {}
              : { target: (step.target ?? context.defaultTarget) as string }),
          })),
        },
        { goal: conversation.text },
      );
      const lines = created.tasks.map((task) => say.step(task.title, task.id));
      return {
        reply: `${decision.acknowledgement}\n${say.deployedMany(created.tasks.length, created.parent.id)}\n${lines.join("\n")}\n${say.follow}`,
        deployed: [
          { room: decision.room, taskId: created.parent.id },
          ...created.tasks.map((task) => ({ room: decision.room, taskId: task.id })),
        ],
      };
    }
    case "attach": {
      const { room, detail } = await findTask(backend, rooms, decision.taskId);
      // A follow-up the worker's session continues with. The worker accepts it
      // because it is written by the task's creator or a superagent it trusts.
      await backend.call("send", {
        room,
        input: {
          body: conversation.text,
          kind: "msg",
          needs: "none",
          thread: detail.thread,
          inReplyTo: detail.thread,
          external: {
            source: "oguri",
            id: conversation.messageId,
            actor: conversation.author,
            human: true,
          },
        },
      });
      return {
        reply: say.passed(detail.task.title, decision.taskId),
        deployed: [],
      };
    }
    case "retarget": {
      const { room, detail } = await findTask(backend, rooms, decision.taskId);
      await backend.call("taskUpdate", {
        room,
        taskId: decision.taskId,
        input: {
          action: "retargeted",
          target: decision.target,
          body: `Moved by the superagent: ${decision.reason}`,
        },
      });
      return {
        reply: say.moved(detail.task.title, decision.target),
        deployed: [],
      };
    }
    case "stop": {
      const { room, detail } = await findTask(backend, rooms, decision.taskId);
      await backend.call("taskUpdate", {
        room,
        taskId: decision.taskId,
        input: { action: "cancelled", body: `Stopped at ${conversation.author}'s request.` },
      });
      return { reply: say.stopped(detail.task.title), deployed: [] };
    }
    case "relink": {
      const { room, detail } = await findTask(backend, rooms, decision.taskId);
      await backend.call("taskUpdate", {
        room,
        taskId: decision.taskId,
        input: {
          action: "relinked",
          body: `Dependencies changed by the superagent: ${decision.reason}`,
          ...(decision.addDependsOn.length === 0 ? {} : { addDependsOn: decision.addDependsOn }),
          ...(decision.removeDependsOn.length === 0
            ? {}
            : { removeDependsOn: decision.removeDependsOn }),
        },
      });
      return { reply: say.relinked(detail.task.title), deployed: [] };
    }
    case "replace": {
      const { room, detail } = await findTask(backend, rooms, decision.taskId);
      const target = decision.target ?? context.defaultTarget;
      const created = await backend.call<Message>("taskCreate", {
        room,
        input: {
          title: decision.title,
          definition: taskDefinition(detail.definition, decision.note),
          mandate,
          ...(target === undefined ? {} : { target }),
          ...(decision.requires.length === 0 ? {} : { requires: decision.requires }),
          ...(detail.task.dependsOn === undefined ? {} : { dependsOn: detail.task.dependsOn }),
        },
      });
      const replacementId = created.header.task?.id ?? created.header.id;
      // Everything still waiting on the cancelled task moves onto its replacement.
      const waiting = (await backend.call<TaskStatus[]>("tasks", { room })).filter(
        (status) =>
          status.task.state === "open" && (status.task.dependsOn ?? []).includes(decision.taskId),
      );
      const moved: string[] = [];
      const failed: string[] = [];
      for (const status of waiting) {
        try {
          await backend.call("taskUpdate", {
            room,
            taskId: status.task.id,
            input: {
              action: "relinked",
              addDependsOn: [replacementId],
              removeDependsOn: [decision.taskId],
              body: `Moved onto the replacement ${replacementId} for cancelled ${decision.taskId}: ${decision.reason}`,
            },
          });
          moved.push(status.task.title);
        } catch (error) {
          failed.push(`${status.task.title}: ${describeError(error)}`);
          context.log(
            `could not move ${status.task.id} onto ${replacementId}: ${describeError(error)}`,
          );
        }
      }
      return {
        reply: `${say.replaced(detail.task.title, replacementId, moved.length)}${
          failed.length === 0 ? "" : `\n${say.replaceFailed(failed.join("; "))}`
        }`,
        deployed: [{ room, taskId: replacementId }],
      };
    }
    case "request_runner": {
      const subject = [
        `Runner '${decision.runner}' needs a person's authorization`,
        decision.machine === undefined ? "" : ` on ${decision.machine}`,
        decision.taskId === undefined ? "" : ` for task ${decision.taskId}`,
        `. Why: ${decision.reason}`,
        `\nAdd it to worker.runners in that machine's policy.yaml if it is not there, and when runner grants are on, grant it at that machine's terminal with: oguri runner grant ${decision.runner} (or reply here to decline). Nothing runs on it until you do.`,
      ].join("");
      const input = {
        body: subject,
        kind: "question",
        needs: "human",
        tags: [FROM_SUPERAGENT_TAG, RUNNER_REQUEST_TAG],
        ...(conversation.author === context.agentId ? {} : { mentions: [conversation.author] }),
      };
      try {
        await backend.call("send", {
          room: conversation.room,
          input:
            conversation.thread === ""
              ? input
              : { ...input, thread: conversation.thread, inReplyTo: conversation.messageId },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "REPLY_BUDGET_EXCEEDED") throw error;
        await backend.call("send", { room: conversation.room, input });
      }
      // The request is the message to the owner; no second reply repeats it.
      return { reply: "", deployed: [] };
    }
    case "answer":
      return { reply: decision.text, deployed: [] };
    case "clarify":
      return { reply: decision.question, deployed: [] };
    default:
      return { reply: "", deployed: [] };
  }
}

/** Reply in a conversation, under the message that asked. */
export async function reply(
  backend: Backend,
  conversation: Pick<Conversation, "room" | "thread" | "messageId" | "author">,
  self: string,
  body: string,
  log: (line: string) => void,
): Promise<void> {
  const input = {
    body,
    kind: "msg",
    needs: "none",
    tags: [FROM_SUPERAGENT_TAG],
    ...(conversation.author === self ? {} : { mentions: [conversation.author] }),
  };
  try {
    // An empty thread is a message to the owner with no conversation behind it,
    // such as a task stuck behind a cancelled dependency that Big did not deploy.
    await backend.call("send", {
      room: conversation.room,
      input:
        conversation.thread === ""
          ? input
          : { ...input, thread: conversation.thread, inReplyTo: conversation.messageId },
    });
  } catch (error) {
    // A long conversation can reach the room's reply budget; start a new thread rather than drop it.
    if ((error as { code?: string }).code !== "REPLY_BUDGET_EXCEEDED") throw error;
    log(`reply budget reached in ${conversation.thread}; replying in a new thread`);
    await backend.call("send", { room: conversation.room, input });
  }
}

/** Join a room, creating it first when nobody has. */
export async function ensureRoom(backend: Backend, room: string, purpose: string): Promise<void> {
  const status = await backend.call<{ subscriptions: string[] }>("status");
  if (status.subscriptions.includes(room)) return;
  try {
    await backend.call("roomJoin", { room });
  } catch {
    try {
      // Conversations with the superagents are long; the generic budget would park them.
      await backend.call("roomCreate", { room, title: "Superagent", purpose, replyBudget: 500 });
    } catch (error) {
      if (!/already exists/.test(describeError(error))) throw error;
      await backend.call("roomJoin", { room });
    }
  }
}
