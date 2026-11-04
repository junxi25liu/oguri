/**
 * Plans: a goal broken into a graph of subtasks, before any of it is written.
 *
 * A plan is what the conductor (`oguri plan`) asks a model for, what a person
 * may write by hand, and what a live agent submits over MCP. All three meet
 * here, so the rules a plan must satisfy are written once.
 *
 * Nothing in a plan is on the wire. It is a recipe for ordinary `task create`
 * calls: one parent, then each subtask in dependency order with `parent` and
 * `dependsOn` set to the ids just created. Graph links are fixed at creation
 * (ADR 0027), so a plan is checked whole before the first task exists. A plan
 * that fails halfway would leave a graph nobody can repair except by
 * cancelling it.
 */

import {
  MAX_TASK_ATTEMPTS,
  MAX_TASK_DEPENDENCIES,
  MAX_TASK_REQUIRES,
  isTaskCapability,
  isTaskTarget,
  type Message,
} from "@oguri/protocol";

import { describeError } from "../errors.ts";
import type { TaskCreateInput } from "../network/tasks.ts";
import { scanForSecrets } from "../scanner/secrets.ts";

/** A plan with more steps than this is a project, not a plan. */
export const MAX_PLAN_TASKS = 50;

/** Keys name steps inside one plan and appear in error messages, so keep them short and plain. */
const PLAN_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLAN_KEYS = ["title", "tasks"] as const;
const PLAN_TASK_KEYS = [
  "key",
  "title",
  "body",
  "dependsOn",
  "requires",
  "target",
  "maxAttempts",
] as const;

export interface PlanTask {
  /** Names this step inside the plan; `dependsOn` refers to it. Never published. */
  key: string;
  title: string;
  /** The task definition: what a worker or agent reads as its instructions. */
  body: string;
  /** Keys of steps that must complete first. */
  dependsOn: string[];
  requires: string[];
  /** An agent id or `machine:<id>`; absent means free to claim. */
  target?: string;
  maxAttempts?: number;
}

export interface Plan {
  title: string;
  tasks: PlanTask[];
}

/**
 * A plan that cannot be created, with every reason at once.
 *
 * All problems rather than the first, because the usual reader is a model or
 * a person fixing a JSON file. Fixing one error per round trip costs a model
 * run each time.
 */
export class PlanError extends Error {
  readonly code = "INVALID_PLAN";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      problems.length === 1
        ? `invalid plan: ${problems[0] ?? ""}`
        : `invalid plan:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "PlanError";
    this.problems = problems;
  }
}

/**
 * The JSON text inside a model's reply.
 *
 * Models wrap JSON in a ```json fence, or put a sentence before it, however
 * firmly they are told not to. A fenced block wins when there is one.
 * Otherwise this takes the first balanced `{ ... }`, reading strings so a
 * brace inside a task body does not end the object early.
 */
export function extractPlanJson(text: string): string {
  const fence = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  if (fence !== null && (fence[1] ?? "").trim().startsWith("{")) {
    return (fence[1] as string).trim();
  }
  const start = text.indexOf("{");
  if (start === -1) throw new PlanError(["the reply contains no JSON object"]);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new PlanError(["the JSON object in the reply is not closed"]);
}

/** Parse and validate a plan from a model reply or a file. */
export function parsePlan(text: string): Plan {
  const json = extractPlanJson(text);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new PlanError([`not valid JSON: ${describeError(error)}`]);
  }
  return validatePlan(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\r\n]/.test(value)
  );
}

/** A list of distinct strings, each passing `valid`; problems are pushed, not thrown. */
function stringSet(
  value: unknown,
  where: string,
  max: number,
  valid: (entry: string) => boolean,
  what: string,
  problems: string[],
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list`);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !valid(entry)) {
      problems.push(`${where} has ${JSON.stringify(entry)}, which is not ${what}`);
    } else if (out.includes(entry)) {
      problems.push(`${where} names ${JSON.stringify(entry)} twice`);
    } else out.push(entry);
  }
  if (out.length > max)
    problems.push(`${where} has ${String(out.length)} entries; at most ${String(max)}`);
  return out;
}

/**
 * Check a parsed plan against every rule a task creation would enforce, plus
 * the plan's own: unique keys, known dependencies, no cycle, at most 50 steps.
 *
 * Unknown keys are refused rather than ignored. A model that writes
 * `depends_on` would otherwise produce a plan whose steps all run at once,
 * and nothing would say so.
 */
export function validatePlan(raw: unknown): Plan {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new PlanError(["a plan must be a JSON object with title and tasks"]);
  for (const key of Object.keys(raw)) {
    if (!(PLAN_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown key '${key}'; a plan has: ${PLAN_KEYS.join(", ")}`);
    }
  }
  if (!isTitle(raw["title"])) {
    problems.push("title must be one non-empty line of at most 200 characters");
  }
  const rawTasks = raw["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    problems.push("tasks must be a non-empty list");
    throw new PlanError(problems);
  }
  if (rawTasks.length > MAX_PLAN_TASKS) {
    problems.push(
      `a plan has at most ${String(MAX_PLAN_TASKS)} tasks; this one has ${String(rawTasks.length)}`,
    );
  }

  const tasks: PlanTask[] = [];
  const keys = new Set<string>();
  rawTasks.forEach((entry: unknown, index) => {
    const at = `tasks[${String(index)}]`;
    if (!isRecord(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const key = entry["key"];
    const where = typeof key === "string" && PLAN_KEY.test(key) ? `task '${key}'` : at;
    for (const name of Object.keys(entry)) {
      if (!(PLAN_TASK_KEYS as readonly string[]).includes(name)) {
        problems.push(
          `${where} has unknown key '${name}'; a task has: ${PLAN_TASK_KEYS.join(", ")}`,
        );
      }
    }
    if (typeof key !== "string" || !PLAN_KEY.test(key)) {
      problems.push(`${at}.key must match ${PLAN_KEY.source}`);
    } else if (keys.has(key)) {
      problems.push(`key '${key}' is used by more than one task`);
    } else keys.add(key);

    const title = entry["title"];
    if (!isTitle(title)) {
      problems.push(`${where} title must be one non-empty line of at most 200 characters`);
    }
    const body = entry["body"];
    if (typeof body !== "string" || body.trim().length === 0) {
      problems.push(`${where} body must be non-empty text`);
    }
    const dependsOn = stringSet(
      entry["dependsOn"],
      `${where} dependsOn`,
      MAX_TASK_DEPENDENCIES,
      () => true,
      "a task key",
      problems,
    );
    const requires = stringSet(
      entry["requires"],
      `${where} requires`,
      MAX_TASK_REQUIRES,
      isTaskCapability,
      "a capability name ([a-z][a-z0-9-]{0,31})",
      problems,
    );
    const target = entry["target"];
    if (target !== undefined && target !== null && !isTaskTarget(target)) {
      problems.push(`${where} target ${JSON.stringify(target)} is not an agent id or machine:<id>`);
    }
    const maxAttempts = entry["maxAttempts"];
    if (
      maxAttempts !== undefined &&
      maxAttempts !== null &&
      (typeof maxAttempts !== "number" ||
        !Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > MAX_TASK_ATTEMPTS)
    ) {
      problems.push(
        `${where} maxAttempts must be an integer from 1 to ${String(MAX_TASK_ATTEMPTS)}`,
      );
    }
    tasks.push({
      key: typeof key === "string" ? key : at,
      title: typeof title === "string" ? title : "",
      body: typeof body === "string" ? body : "",
      dependsOn,
      requires,
      ...(typeof target === "string" ? { target } : {}),
      ...(typeof maxAttempts === "number" ? { maxAttempts } : {}),
    });
  });

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) problems.push(`task '${task.key}' depends on itself`);
      else if (!keys.has(dependency)) {
        problems.push(
          `task '${task.key}' depends on '${dependency}', which is not a key in this plan`,
        );
      }
    }
  }
  if (problems.length > 0) throw new PlanError(problems);

  const plan: Plan = { title: raw["title"] as string, tasks };
  planOrder(plan);
  return plan;
}

/**
 * The plan's tasks in an order where every dependency comes first.
 *
 * Kahn's algorithm, always taking the earliest ready step in the plan's own
 * order, so a plan already written in dependency order comes out unchanged.
 * A cycle is refused with the keys on it.
 */
export function planOrder(plan: Plan): PlanTask[] {
  const remaining = new Map(plan.tasks.map((task) => [task.key, new Set(task.dependsOn)]));
  const ordered: PlanTask[] = [];
  const done = new Set<string>();
  while (ordered.length < plan.tasks.length) {
    const next = plan.tasks.find(
      (task) =>
        !done.has(task.key) && [...(remaining.get(task.key) ?? [])].every((d) => done.has(d)),
    );
    if (next === undefined) {
      const stuck = plan.tasks.filter((task) => !done.has(task.key)).map((task) => task.key);
      throw new PlanError([`dependencies form a cycle among: ${stuck.join(", ")}`]);
    }
    ordered.push(next);
    done.add(next.key);
  }
  return ordered;
}

/** Give every step without a target the same one. Steps that name a target keep it. */
export function withDefaultTarget(plan: Plan, target: string | undefined): Plan {
  if (target === undefined) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((task) => (task.target === undefined ? { ...task, target } : task)),
  };
}

/**
 * Every text the plan would publish that the secret scanner refuses.
 *
 * Each send scans its own body, so a secret in step 30 would otherwise be
 * refused after 29 tasks had been written. Scanning first keeps a plan
 * all-or-nothing. A problem names where the finding is, never what it is.
 */
export function planSecretProblems(plan: Plan, goal: string): string[] {
  const texts: [string, string][] = [
    ["goal", goal],
    ["plan title", plan.title],
    ...plan.tasks.flatMap((task): [string, string][] => [
      [`task '${task.key}' title`, task.title],
      [`task '${task.key}' body`, task.body],
    ]),
  ];
  const problems: string[] = [];
  for (const [where, text] of texts) {
    for (const finding of scanForSecrets(text)) {
      problems.push(
        `${where}: possible secret (${finding.rule}, line ${String(finding.line)}); git history is permanent`,
      );
    }
  }
  return problems;
}

/** The two task operations creating a plan needs. Both surfaces adapt their `Backend` to it. */
export interface PlanWriter {
  createTask(room: string, input: TaskCreateInput): Promise<Message>;
  claimTask(room: string, taskId: string, body: string): Promise<Message>;
}

export interface CreatedPlanTask {
  key: string;
  id: string;
  title: string;
}

export interface CreatedPlan {
  room: string;
  parent: { id: string; title: string };
  /** False when the claim on the parent was refused, e.g. by an approval rule. */
  parentClaimed: boolean;
  /** Why the parent claim was refused. */
  claimError?: string;
  /** In creation order, which is dependency order. */
  tasks: CreatedPlanTask[];
}

/** A plan that failed partway, with what exists so the caller can cancel or finish it. */
export class PlanCreateError extends Error {
  readonly code = "PLAN_PARTIAL";
  readonly created: CreatedPlan | null;

  constructor(cause: unknown, created: CreatedPlan | null) {
    const done =
      created === null
        ? "nothing was created"
        : `created parent ${created.parent.id} and ${String(created.tasks.length)} subtask(s): ${
            created.tasks.map((task) => `${task.key}=${task.id}`).join(", ") || "none"
          }`;
    super(`plan creation stopped: ${describeError(cause)} (${done})`, { cause });
    this.name = "PlanCreateError";
    this.created = created;
  }
}

/**
 * Write a plan as tasks: a parent the planner claims, then each step as its subtask.
 *
 * The parent carries the goal. The planner claims it so the goal has an owner
 * who answers for it while the steps run. Steps go in dependency order, so
 * each `dependsOn` names tasks that already exist, which `task create`
 * requires. A refused parent claim does not stop the steps: they are the work,
 * and the parent can be claimed later.
 */
export async function createPlanTasks(
  writer: PlanWriter,
  room: string,
  plan: Plan,
  options: { goal?: string } = {},
): Promise<CreatedPlan> {
  const trimmed = options.goal?.trim() ?? "";
  const goal = trimmed.length > 0 ? trimmed : plan.title;
  const secrets = planSecretProblems(plan, goal);
  if (secrets.length > 0) throw new PlanError(secrets);
  const ordered = planOrder(plan);

  let created: CreatedPlan | null = null;
  try {
    const parentMessage = await writer.createTask(room, {
      title: plan.title,
      definition: `${goal}\n\nPlanned as ${String(ordered.length)} subtask(s) with oguri plan.`,
    });
    const parentId = parentMessage.header.task?.id;
    if (parentId === undefined) throw new Error("the parent task was created without an id");
    created = {
      room,
      parent: { id: parentId, title: plan.title },
      parentClaimed: false,
      tasks: [],
    };
    try {
      await writer.claimTask(room, parentId, "Planner: owns this goal while its subtasks run.");
      created.parentClaimed = true;
    } catch (error) {
      created.claimError = describeError(error);
    }

    const ids = new Map<string, string>();
    for (const task of ordered) {
      const message = await writer.createTask(room, {
        title: task.title,
        definition: task.body,
        parent: parentId,
        ...(task.dependsOn.length === 0
          ? {}
          : { dependsOn: task.dependsOn.map((key) => ids.get(key) as string) }),
        ...(task.requires.length === 0 ? {} : { requires: task.requires }),
        ...(task.target === undefined ? {} : { target: task.target }),
        ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
      });
      const id = message.header.task?.id;
      if (id === undefined) throw new Error(`task '${task.key}' was created without an id`);
      ids.set(task.key, id);
      created.tasks.push({ key: task.key, id, title: task.title });
    }
    return created;
  } catch (error) {
    throw new PlanCreateError(error, created);
  }
}
