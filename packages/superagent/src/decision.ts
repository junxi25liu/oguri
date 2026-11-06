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

import { isRoomId, isTaskCapability, isTaskTarget, isUlid } from "@oguri/protocol";
import { hasSecrets, TIER_REASON_LIMIT } from "@oguri/core";

/** The decisions the router may make, as superagent's main Session makes them. */
export const ROUTE_KINDS = [
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
  "read",
] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/**
 * Which runner a worker gets, as the router chose it (ADR 0034).
 *
 * `tier` is the usual choice. `runner` alone, with no tier, is for the one
 * exception: the owner named a model, so the runner that has it is pinned and
 * never moved up. `reason` is one line an auditor reads beside the task.
 */
export interface RouteTier {
  tier?: string;
  runner?: string;
  effort?: string;
  reason: string;
}

/** One step of a plan the router proposes for a larger request. */
export interface RoutePlanStep {
  key: string;
  title: string;
  body: string;
  dependsOn: string[];
  requires: string[];
  target?: string;
  choice?: RouteTier;
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
      choice?: RouteTier;
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
  /** Change the dependencies of a task nobody has claimed: drop one that cannot complete, or add one. */
  | {
      kind: "relink";
      taskId: string;
      addDependsOn: string[];
      removeDependsOn: string[];
      reason: string;
    }
  /** Rebuild a cancelled task other tasks wait on, and move those tasks onto the new one. */
  | {
      kind: "replace";
      /** The cancelled task being replaced. */
      taskId: string;
      title: string;
      target?: string;
      requires: string[];
      note?: string;
      reason: string;
    }
  /** Ask a person to authorize a runner; it authorizes nothing itself. */
  | { kind: "request_runner"; runner: string; machine?: string; taskId?: string; reason: string }
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
  /**
   * Tasks in the snapshot: open ones may be attached to or stopped, ended ones attached to.
   * `state` lets a decision that needs a particular state (relinking an unclaimed task,
   * replacing a cancelled one) be checked; without it only `open` is known.
   */
  tasks: readonly { id: string; open: boolean; state?: string; dependsOn?: readonly string[] }[];
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
  /**
   * The runner tiers of this machine's policy, cheapest first, and the
   * runners that may run (ADR 0034). With tiers, every worker a decision
   * deploys must name a tier, or a runner the owner asked for by name.
   */
  tiers?: readonly ScopeTier[];
  runners?: readonly ScopeRunner[];
}

/** A runner as the router may name it. */
export interface ScopeRunner {
  name: string;
  model?: string;
  /** The levels a task may ask for on this runner. */
  efforts: readonly string[];
}

export interface ScopeTier {
  name: string;
  runners: readonly string[];
  effort?: string;
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
/** A runner is named the way `worker.runners` names it. */
const RUNNER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
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
 * The runner choice in a decision or a plan step, checked against the scope.
 *
 * Every name must be one the router was shown: a tier of this machine's
 * policy, a runner in that tier, a level on that runner's `efforts`. Nothing
 * here is repaired; a wrong name refuses the decision with the reason, so the
 * model decides again rather than a worker running on something else.
 */
function checkChoice(
  record: Record<string, unknown>,
  scope: RouteScope,
  problems: string[],
): RouteTier | undefined {
  const tier = str(record, "tier", problems, { max: 32, optional: true });
  const runner = str(record, "runner", problems, { max: 32, optional: true });
  const effort = str(record, "effort", problems, { max: 32, optional: true });
  const reason = str(record, "tierReason", problems, {
    max: TIER_REASON_LIMIT,
    optional: true,
    oneLine: true,
  });
  const tiers = scope.tiers ?? [];
  const runners = scope.runners ?? [];
  if (tier === undefined && runner === undefined) {
    if (effort !== undefined) problems.push("'effort' needs a 'tier' or a 'runner'");
    if (tiers.length > 0) {
      problems.push(
        `pick a 'tier' (${tiers.map((t) => t.name).join(", ")}), or the 'runner' the owner asked for by name, with a 'tierReason'`,
      );
    }
    return undefined;
  }
  if (reason === undefined) problems.push("'tierReason' is missing: say in one line why this tier");
  const known = (name: string): ScopeRunner | undefined => runners.find((r) => r.name === name);
  let candidates: ScopeRunner[] = [];
  if (tier !== undefined) {
    const found = tiers.find((t) => t.name === tier);
    if (found === undefined) {
      problems.push(
        tiers.length === 0
          ? `tier '${tier}' was named, but this machine configures no worker.tiers`
          : `tier '${tier}' is not one of ${tiers.map((t) => t.name).join(", ")}`,
      );
    } else if (runner !== undefined && !found.runners.includes(runner)) {
      problems.push(`runner '${runner}' is not in tier '${tier}' (${found.runners.join(", ")})`);
    } else {
      const names = runner === undefined ? found.runners : [runner];
      candidates = names.map(known).filter((r): r is ScopeRunner => r !== undefined);
      if (candidates.length === 0) {
        problems.push(`no runner of tier '${tier}' may run here`);
      }
    }
  } else if (runner !== undefined) {
    const found = known(runner);
    if (found === undefined) {
      problems.push(
        `runner '${runner}' is not one this machine may run (${runners.map((r) => r.name).join(", ") || "none"})`,
      );
    } else {
      candidates = [found];
    }
  }
  if (effort !== undefined) {
    for (const candidate of candidates) {
      if (!candidate.efforts.includes(effort)) {
        problems.push(
          `effort '${effort}' is not allowed on runner '${candidate.name}' (${candidate.efforts.join(", ") || "none"})`,
        );
      }
    }
  }
  return {
    ...(tier === undefined ? {} : { tier }),
    ...(runner === undefined ? {} : { runner }),
    ...(effort === undefined ? {} : { effort }),
    reason: reason ?? "",
  };
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
      const choice = checkChoice(record, scope, problems);
      decision = {
        kind: "accept",
        title,
        room: room ?? "",
        requires,
        acknowledgement,
        reason,
        ...(target === undefined ? {} : { target }),
        ...(note === undefined ? {} : { note }),
        ...(choice === undefined ? {} : { choice }),
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
          const choice = checkChoice(step, scope, stepProblems);
          problems.push(...stepProblems.map((problem) => `${at}: ${problem}`));
          steps.push({
            key,
            title: stepTitle,
            body,
            dependsOn,
            requires,
            ...(target === undefined ? {} : { target }),
            ...(choice === undefined ? {} : { choice }),
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
    case "relink": {
      const taskId = str(record, "taskId", problems, { max: 64 }) ?? "";
      const addDependsOn = strings(record, "addDependsOn", problems);
      const removeDependsOn = strings(record, "removeDependsOn", problems);
      const known = scope.tasks.find((task) => task.id === taskId);
      if (taskId !== "" && known === undefined) {
        problems.push(`task '${taskId}' was not in the snapshot`);
      } else if (known !== undefined && (known.state ?? (known.open ? "open" : "")) !== "open") {
        problems.push(
          `task '${taskId}' is already started or ended; dependencies change only on an unclaimed task`,
        );
      }
      if (addDependsOn.length + removeDependsOn.length === 0) {
        problems.push("'addDependsOn' or 'removeDependsOn' must name at least one task");
      }
      for (const id of addDependsOn) {
        if (id === taskId) problems.push("a task cannot depend on itself");
        else if (!isUlid(id) || !scope.tasks.some((task) => task.id === id)) {
          problems.push(`task '${id}' was not in the snapshot`);
        }
      }
      for (const id of removeDependsOn) {
        if (known?.dependsOn !== undefined && !known.dependsOn.includes(id)) {
          problems.push(`'${id}' is not a dependency of task '${taskId}'`);
        }
      }
      for (const id of addDependsOn) {
        if (removeDependsOn.includes(id)) problems.push(`'${id}' is both added and removed`);
      }
      decision = { kind: "relink", taskId, addDependsOn, removeDependsOn, reason };
      break;
    }
    case "replace": {
      const taskId = str(record, "taskId", problems, { max: 64 }) ?? "";
      const title = str(record, "title", problems, { max: MAX_TASK_TITLE, oneLine: true }) ?? "";
      const target = str(record, "target", problems, { max: 128, optional: true });
      const note = str(record, "note", problems, { max: ROUTE_LIMITS.noteChars, optional: true });
      const requires = strings(record, "requires", problems);
      const known = scope.tasks.find((task) => task.id === taskId);
      if (taskId !== "" && known === undefined) {
        problems.push(`task '${taskId}' was not in the snapshot`);
      } else if (known !== undefined && known.state !== "cancelled") {
        problems.push(`task '${taskId}' is not cancelled, so there is nothing to replace`);
      }
      checkTarget(target, scope, problems);
      checkCapabilities(requires, scope, problems);
      checkAddressed(target, requires, scope, "the replacement worker", problems);
      decision = {
        kind: "replace",
        taskId,
        title,
        requires,
        reason,
        ...(target === undefined ? {} : { target }),
        ...(note === undefined ? {} : { note }),
      };
      break;
    }
    case "request_runner": {
      const runner = str(record, "runner", problems, { max: 40 }) ?? "";
      const machine = str(record, "machine", problems, { max: 128, optional: true });
      const taskId = str(record, "taskId", problems, { max: 64, optional: true });
      if (runner !== "" && !RUNNER_NAME.test(runner)) {
        problems.push(`runner '${runner}' is not a runner name (lowercase letters, digits, -)`);
      }
      if (machine !== undefined && !scope.targets.includes(machine)) {
        problems.push(`machine '${machine}' is not on the roster`);
      }
      if (taskId !== undefined && !scope.tasks.some((task) => task.id === taskId)) {
        problems.push(`task '${taskId}' was not in the snapshot`);
      }
      decision = {
        kind: "request_runner",
        runner,
        reason,
        ...(machine === undefined ? {} : { machine }),
        ...(taskId === undefined ? {} : { taskId }),
      };
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
      return [
        decision.title,
        decision.acknowledgement,
        decision.note ?? "",
        decision.choice?.reason ?? "",
      ];
    case "plan":
      return [
        decision.title,
        decision.acknowledgement,
        ...decision.steps.flatMap((step) => [step.title, step.body, step.choice?.reason ?? ""]),
      ];
    case "answer":
      return [decision.text];
    case "clarify":
      return [decision.question];
    case "replace":
      return [decision.title, decision.note ?? "", decision.reason];
    case "request_runner":
      return [decision.runner, decision.reason];
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
