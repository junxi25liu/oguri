/**
 * What the big superagent may decide, and the code that checks it (ADR 0031).
 *
 * The router is a model. Its reply is data, never an instruction: it is parsed
 * into one of a closed set of decisions, and every reference in it is checked
 * against what the router was shown. A reply that names a task, room, target,
 * or capability it was not shown is refused, not repaired. Who may ask was
 * decided before the model saw anything (`admit` in intake), and nothing here
 * can widen it.
 */

import { isRoomId, isTaskCapability, isTaskTarget } from "@oguri/protocol";
import { hasSecrets } from "@oguri/core";

/** The decisions the router may make, as superagent's main Session makes them. */
export const ROUTE_KINDS = [
  "accept",
  "plan",
  "attach",
  "retarget",
  "answer",
  "clarify",
  "stop",
  "ignore",
  "read",
] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** One step of a plan the router proposes for a larger request. */
export interface RoutePlanStep {
  key: string;
  title: string;
  body: string;
  dependsOn: string[];
  requires: string[];
  target?: string;
}

export type RouteDecision =
  | {
      kind: "accept";
      title: string;
      /** What the worker reads, beside the original request, which is always included verbatim. */
      note?: string;
      room: string;
      target?: string;
      requires: string[];
      acknowledgement: string;
      reason: string;
    }
  | {
      kind: "plan";
      title: string;
      room: string;
      steps: RoutePlanStep[];
      acknowledgement: string;
      reason: string;
    }
  | { kind: "attach"; taskId: string; reason: string }
  | { kind: "retarget"; taskId: string; target: string; reason: string }
  | { kind: "answer"; text: string; reason: string }
  | { kind: "clarify"; question: string; reason: string }
  | { kind: "stop"; taskId: string; reason: string }
  | { kind: "ignore"; reason: string }
  /** Read tasks' full history before deciding, as an orchestrator read would. */
  | { kind: "read"; taskIds: string[]; reason: string };

/** At most this many tasks in one read. */
export const MAX_READ_TASKS = 3;

/** What the router was shown, and so the only things its decision may name. */
export interface RouteScope {
  /** The kinds this role may choose. Big may choose all; a small superagent or a coordination pass fewer. */
  kinds: readonly RouteKind[];
  rooms: readonly string[];
  /** Agent ids and `machine:<id>` tokens on the roster. */
  targets: readonly string[];
  capabilities: readonly string[];
  /** Tasks in the snapshot: open ones may be attached to or stopped, ended ones attached to. */
  tasks: readonly { id: string; open: boolean }[];
  /** The router may answer from the snapshot. Off makes `answer` a refusal. */
  mayAnswer: boolean;
  /** At most this many steps in a plan. */
  maxSteps: number;
  /**
   * Where a worker goes when a decision names no target, such as a small
   * superagent's own machine. Without one, a decision must name a target or
   * required capabilities: a worker claims only work addressed to it.
   */
  defaultTarget?: string;
}

export class RouteError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the router's decision was refused: ${problems.join("; ")}`);
    this.name = "RouteError";
    this.problems = problems;
  }
}

/** Upper bounds, so a reply cannot flood a chat or a task. */
export const ROUTE_LIMITS = {
  acknowledgementWords: 40,
  answerChars: 2000,
  questionChars: 600,
  noteChars: 2000,
  reasonChars: 500,
  bodyChars: 8000,
} as const;

const KEY = /^[A-Za-z0-9._-]{1,40}$/;
/** The protocol's limit on a task title: one line of at most 200 characters. */
const MAX_TASK_TITLE = 200;

/** The JSON object in a model's reply: the whole reply, a fenced block, or the outermost braces. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try the next shape
    }
  }
  // Claude's --output-format json wraps the text in `result`.
  return undefined;
}

/** A Claude `--output-format json` envelope carries the model's text in `result`. */
export function unwrapEnvelope(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record["type"] === "result" && typeof record["result"] === "string") {
      return extractJson(record["result"]);
    }
  }
  return value;
}

function str(
  record: Record<string, unknown>,
  key: string,
  problems: string[],
  options: { max: number; optional?: boolean; oneLine?: boolean },
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    if (options.optional !== true) problems.push(`'${key}' is missing`);
    return undefined;
  }
  if (typeof value !== "string") {
    problems.push(`'${key}' must be a string`);
    return undefined;
  }
  const text = value.trim();
  if (text.length > options.max)
    problems.push(`'${key}' is longer than ${String(options.max)} characters`);
  if (options.oneLine === true && text.includes("\n")) problems.push(`'${key}' must be one line`);
  return text;
}

function strings(record: Record<string, unknown>, key: string, problems: string[]): string[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    problems.push(`'${key}' must be a list of strings`);
    return [];
  }
  return [...new Set(value as string[])];
}

function checkRoom(room: string | undefined, scope: RouteScope, problems: string[]): void {
  if (room === undefined) return;
  if (!isRoomId(room) || !scope.rooms.includes(room)) {
    problems.push(`room '${room}' is not one the router may use (${scope.rooms.join(", ")})`);
  }
}

function checkTarget(target: string | undefined, scope: RouteScope, problems: string[]): void {
  if (target === undefined) return;
  if (!isTaskTarget(target) || !scope.targets.includes(target)) {
    problems.push(`target '${target}' is not on the roster`);
  }
}

function checkCapabilities(requires: string[], scope: RouteScope, problems: string[]): void {
  for (const capability of requires) {
    if (!isTaskCapability(capability) || !scope.capabilities.includes(capability)) {
      problems.push(`capability '${capability}' is not one any agent declares`);
    }
  }
}

/** A worker only claims work addressed to its agent or machine, or matching its capabilities. */
function checkAddressed(
  target: string | undefined,
  requires: readonly string[],
  scope: RouteScope,
  what: string,
  problems: string[],
): void {
  if (target === undefined && requires.length === 0 && scope.defaultTarget === undefined) {
    problems.push(`${what} names no target or required capability, so no machine would pick it up`);
  }
}

function checkWords(text: string | undefined, max: number, key: string, problems: string[]): void {
  if (text === undefined) return;
  const words = text.split(/\s+/u).filter(Boolean).length;
  const cjk = (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
  if (Math.max(words, Math.ceil(cjk / 2)) > max)
    problems.push(`'${key}' is longer than ${String(max)} words`);
}

/**
 * Turn a model's reply into a decision the code accepts, or throw.
 *
 * Everything the reply names must be in `scope`. Text that goes back to a chat
 * or into a task is secret-scanned, because a model can echo what it was shown.
 */
export function parseRouteDecision(raw: unknown, scope: RouteScope): RouteDecision {
  const value = unwrapEnvelope(typeof raw === "string" ? extractJson(raw) : raw);
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RouteError(["the reply is not one JSON object"]);
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  const kind = record["kind"];
  if (typeof kind !== "string" || !(ROUTE_KINDS as readonly string[]).includes(kind)) {
    throw new RouteError([`'kind' must be one of: ${ROUTE_KINDS.join(", ")}`]);
  }
  if (!scope.kinds.includes(kind as RouteKind)) {
    throw new RouteError([
      `'${kind}' is not a decision this superagent may make (${scope.kinds.join(", ")})`,
    ]);
  }
  const reason = str(record, "reason", problems, { max: ROUTE_LIMITS.reasonChars }) ?? "";
  const openTask = (id: string | undefined): void => {
    if (id === undefined) return;
    const known = scope.tasks.find((task) => task.id === id);
    if (known === undefined) problems.push(`task '${id}' was not in the snapshot`);
    else if ((kind === "stop" || kind === "retarget") && !known.open) {
      problems.push(`task '${id}' has already ended`);
    }
  };

  let decision: RouteDecision;
  switch (kind as RouteKind) {
    case "accept": {
      const title = str(record, "title", problems, { max: MAX_TASK_TITLE, oneLine: true }) ?? "";
      const room = str(record, "room", problems, { max: 64 });
      const target = str(record, "target", problems, { max: 128, optional: true });
      const note = str(record, "note", problems, { max: ROUTE_LIMITS.noteChars, optional: true });
      const acknowledgement = str(record, "acknowledgement", problems, { max: 600 }) ?? "";
      const requires = strings(record, "requires", problems);
      checkRoom(room, scope, problems);
      checkTarget(target, scope, problems);
      checkCapabilities(requires, scope, problems);
      checkAddressed(target, requires, scope, "the worker", problems);
      checkWords(acknowledgement, ROUTE_LIMITS.acknowledgementWords, "acknowledgement", problems);
      decision = {
        kind: "accept",
        title,
        room: room ?? "",
        requires,
        acknowledgement,
        reason,
        ...(target === undefined ? {} : { target }),
        ...(note === undefined ? {} : { note }),
      };
      break;
    }
    case "plan": {
      const title = str(record, "title", problems, { max: MAX_TASK_TITLE, oneLine: true }) ?? "";
      const room = str(record, "room", problems, { max: 64 });
      const acknowledgement = str(record, "acknowledgement", problems, { max: 600 }) ?? "";
      checkRoom(room, scope, problems);
      checkWords(acknowledgement, ROUTE_LIMITS.acknowledgementWords, "acknowledgement", problems);
      const rawSteps = record["steps"];
      const steps: RoutePlanStep[] = [];
      if (!Array.isArray(rawSteps) || rawSteps.length < 2) {
        problems.push("'steps' must list at least two steps; one step is an accept");
      } else if (rawSteps.length > scope.maxSteps) {
        problems.push(`'steps' lists more than ${String(scope.maxSteps)} steps`);
      } else {
        const keys = new Set<string>();
        for (const [index, item] of rawSteps.entries()) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            problems.push(`step ${String(index + 1)} is not an object`);
            continue;
          }
          const step = item as Record<string, unknown>;
          const at = `step ${String(index + 1)}`;
          const stepProblems: string[] = [];
          const key = str(step, "key", stepProblems, { max: 40 }) ?? "";
          if (key !== "" && !KEY.test(key))
            stepProblems.push(`'key' '${key}' has characters a key may not`);
          if (keys.has(key)) stepProblems.push(`'key' '${key}' is used twice`);
          keys.add(key);
          const stepTitle =
            str(step, "title", stepProblems, { max: MAX_TASK_TITLE, oneLine: true }) ?? "";
          const body = str(step, "body", stepProblems, { max: ROUTE_LIMITS.bodyChars }) ?? "";
          const target = str(step, "target", stepProblems, { max: 128, optional: true });
          const requires = strings(step, "requires", stepProblems);
          const dependsOn = strings(step, "dependsOn", stepProblems);
          checkTarget(target, scope, stepProblems);
          checkCapabilities(requires, scope, stepProblems);
          checkAddressed(target, requires, scope, "this step", stepProblems);
          problems.push(...stepProblems.map((problem) => `${at}: ${problem}`));
          steps.push({
            key,
            title: stepTitle,
            body,
            dependsOn,
            requires,
            ...(target === undefined ? {} : { target }),
          });
        }
        for (const step of steps) {
          for (const dependency of step.dependsOn) {
            if (!keys.has(dependency))
              problems.push(`step '${step.key}' depends on unknown '${dependency}'`);
            if (dependency === step.key) problems.push(`step '${step.key}' depends on itself`);
          }
        }
        if (problems.length === 0 && hasCycle(steps))
          problems.push("the steps' dependencies form a cycle");
      }
      decision = { kind: "plan", title, room: room ?? "", steps, acknowledgement, reason };
      break;
    }
    case "attach":
    case "stop": {
      const taskId = str(record, "taskId", problems, { max: 64 }) ?? "";
      openTask(taskId === "" ? undefined : taskId);
      decision = { kind: kind as "attach" | "stop", taskId, reason };
      break;
    }
    case "read": {
      const taskIds = strings(record, "taskIds", problems);
      if (taskIds.length === 0) problems.push("'taskIds' must name at least one task");
      if (taskIds.length > MAX_READ_TASKS) {
        problems.push(`'taskIds' names more than ${String(MAX_READ_TASKS)} tasks`);
      }
      for (const id of taskIds) {
        if (!scope.tasks.some((task) => task.id === id)) {
          problems.push(`task '${id}' was not in the snapshot`);
        }
      }
      decision = { kind: "read", taskIds, reason };
      break;
    }
    case "retarget": {
      const taskId = str(record, "taskId", problems, { max: 64 }) ?? "";
      const target = str(record, "target", problems, { max: 128 }) ?? "";
      openTask(taskId === "" ? undefined : taskId);
      checkTarget(target === "" ? undefined : target, scope, problems);
      decision = { kind: "retarget", taskId, target, reason };
      break;
    }
    case "answer": {
      if (!scope.mayAnswer)
        problems.push("this router may not answer; superagent.big.answer is false");
      const text = str(record, "text", problems, { max: ROUTE_LIMITS.answerChars }) ?? "";
      decision = { kind: "answer", text, reason };
      break;
    }
    case "clarify": {
      const question = str(record, "question", problems, { max: ROUTE_LIMITS.questionChars }) ?? "";
      decision = { kind: "clarify", question, reason };
      break;
    }
    default:
      decision = { kind: "ignore", reason };
  }

  for (const text of outgoingText(decision)) {
    if (hasSecrets(text)) {
      problems.push("the decision contains what looks like a secret");
      break;
    }
  }
  if (problems.length > 0) throw new RouteError(problems);
  return decision;
}

/** Everything a decision would write down or send. */
function outgoingText(decision: RouteDecision): string[] {
  switch (decision.kind) {
    case "accept":
      return [decision.title, decision.acknowledgement, decision.note ?? ""];
    case "plan":
      return [
        decision.title,
        decision.acknowledgement,
        ...decision.steps.flatMap((step) => [step.title, step.body]),
      ];
    case "answer":
      return [decision.text];
    case "clarify":
      return [decision.question];
    default:
      return [decision.reason];
  }
}

function hasCycle(steps: readonly RoutePlanStep[]): boolean {
  const edges = new Map(steps.map((step) => [step.key, step.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string): boolean => {
    if (state.get(key) === "done") return false;
    if (state.get(key) === "visiting") return true;
    state.set(key, "visiting");
    for (const next of edges.get(key) ?? []) if (visit(next)) return true;
    state.set(key, "done");
    return false;
  };
  return steps.some((step) => visit(step.key));
}
