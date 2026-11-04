import { isExternalField, isExternalSource } from "./external.ts";
import { MalformedMessageError, ProtocolError } from "./errors.ts";
import { isUlid } from "./ids.ts";
import { isAgentId, isMachineId, isMachineToken, machineFromToken } from "./identifiers.ts";

export const TASK_STATES = [
  "open",
  "claimed",
  "in_progress",
  "blocked",
  "stuck",
  "completed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_ACTIONS = [
  "created",
  "refined",
  "retargeted",
  "claimed",
  "started",
  "progressed",
  "blocked",
  "stuck",
  "released",
  "completed",
  "cancelled",
  "reopened",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const TASK_UPDATE_ACTIONS = [
  "refined",
  "retargeted",
  "started",
  "progressed",
  "blocked",
  "stuck",
  "released",
  "completed",
  "cancelled",
  "reopened",
] as const;
export type TaskUpdateAction = (typeof TASK_UPDATE_ACTIONS)[number];

export const TERMINAL_TASK_STATES = ["completed", "cancelled"] as const;
export const DEFAULT_TASK_STALE_AFTER_SECONDS = 24 * 60 * 60;

/** Full task snapshot carried by every append-only lifecycle event. */
export interface Task {
  /** Stable ULID shared by every event in this task lifecycle. */
  id: string;
  state: TaskState;
  action: TaskAction;
  creator: string;
  title: string;
  /**
   * Explicit target while open. Undefined means any room subscriber may claim it.
   *
   * Either an agent id or a `machine:<id>` token. A machine target is how work
   * is handed to a *computer* rather than to one agent on it: the box that has
   * the repository checked out, the toolchain installed and the service running
   * is the thing that can do the work, and which of the sessions open on it is
   * free is not knowable to the sender. Any agent on the named machine may
   * claim it, and exactly one wins — the claim is an append-only event reduced
   * like every other.
   */
  target?: string;
  /** Agent that accepted responsibility. Present after claim until release/reopen. */
  assignee?: string;
  /**
   * The machine the assignee claimed from, present only on a machine-targeted task.
   *
   * This exists so the claim can be validated **from the event alone**. Every
   * machine reduces the same log into the same task state, and that determinism
   * is what makes a claim a decision rather than an opinion — so "is this
   * claimer allowed" must not depend on the reader's roster. A reader that had
   * not yet fetched the claimer's card would otherwise reject an event its
   * neighbour accepted, and the two would disagree about who owns the work.
   *
   * Self-asserted, exactly like `from` and like the machine on an agent card:
   * it identifies, it does not authenticate.
   */
  assigneeMachine?: string;
  /** A non-terminal task with no valid event for this many seconds is stale. */
  staleAfterSeconds: number;
  /**
   * Tasks in the same room that must be `completed` before this one may be
   * claimed. Fixed at creation. Absent means no dependencies.
   */
  dependsOn?: string[];
  /** The task in the same room this one is a subtask of. Fixed at creation. */
  parent?: string;
  /**
   * Capability names a claimant must declare. Fixed at creation. Absent means
   * any eligible agent may claim.
   */
  requires?: string[];
  /** Upper bound on accepted claims, 1..20. Fixed at creation. Absent means unbounded. */
  maxAttempts?: number;
  /**
   * How many claims have been accepted so far. Absent means 0.
   *
   * The reducer derives this from the log and checks it when an event carries
   * it, so a writer that omits it — every client older than the field — cannot
   * dodge `maxAttempts`.
   */
  attempt?: number;
  /**
   * The required capabilities the claimant declares, on a `claimed` event only.
   *
   * Like `assigneeMachine`, this exists so the claim is validated from the
   * event alone and every reader reaches the same verdict. Self-asserted: it
   * identifies, it does not authenticate.
   */
  claimantCapabilities?: string[];
  /**
   * The outside conversation the task was requested in (ADR 0030): where its
   * acknowledgement, questions, and result go back. Fixed at creation.
   */
  origin?: TaskOrigin;
  /** Why the task may be done, as the intake machine's policy decided (ADR 0030). Fixed at creation. */
  mandate?: TaskMandate;
}

/** Where a task was requested outside oguri. Every field identifies; none authenticates. */
export interface TaskOrigin {
  /** The source, such as `feishu`. */
  source: string;
  /** The conversation, such as a Feishu chat id. */
  conversation: string;
  /** The message that asked for the work; replies go under it. */
  message: string;
  /** The source's thread or root id, when the request was in one. */
  thread?: string;
  /** Who asked, in the source's own identity. */
  requester: string;
  /** A link to the request, when the source has one. */
  url?: string;
}

export const MANDATE_STRENGTHS = ["explicit", "inferred"] as const;
export type MandateStrength = (typeof MANDATE_STRENGTHS)[number];
/**
 * How the request was admitted: a listed person addressed the agent, a person
 * followed up on a task thread, a chat's admission rule let it in, or the
 * superagent router accepted an admitted request and chose where it runs
 * (ADR 0031). Code still decided who may ask; `router` records that a model
 * then decided what to do with it.
 */
export const MANDATE_VIA = ["addressed", "followup", "admission", "router"] as const;
export type MandateVia = (typeof MANDATE_VIA)[number];

/** The authorization an intake decision grants a task. Immutable, like the task's identity. */
export interface TaskMandate {
  strength: MandateStrength;
  via: MandateVia;
  /** Hash of the intake policy the decision was made under, 8 to 64 lowercase hex characters. */
  policy: string;
}

export interface NewTaskInput {
  id: string;
  creator: string;
  title: string;
  target?: string;
  staleAfterSeconds?: number;
  dependsOn?: readonly string[];
  parent?: string;
  requires?: readonly string[];
  maxAttempts?: number;
  origin?: TaskOrigin;
  mandate?: TaskMandate;
}

export const MAX_TASK_DEPENDENCIES = 32;
export const MAX_TASK_REQUIRES = 16;
export const MAX_TASK_ATTEMPTS = 20;
/** A claimant may assert more than the task asks for; this bounds the list. */
const MAX_CLAIMANT_CAPABILITIES = 32;
const TASK_CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Why a transition was refused, as a stable code.
 *
 * The graph refusals get their own codes because the caller's next move
 * differs: wait for a dependency, give up on the task, or go to another agent.
 */
export const TASK_TRANSITION_CODES = [
  "INVALID_TASK_TRANSITION",
  "DEPENDENCY_PENDING",
  "ATTEMPTS_EXHAUSTED",
  "CAPABILITY_MISSING",
] as const;
export type TaskTransitionCode = (typeof TASK_TRANSITION_CODES)[number];

export class TaskTransitionError extends ProtocolError {
  constructor(message: string, code: TaskTransitionCode = "INVALID_TASK_TRANSITION") {
    super(code, message);
    this.name = "TaskTransitionError";
  }
}

export const TASK_WIRE_KEYS = [
  "task_id",
  "task_state",
  "task_action",
  "task_creator",
  "task_title",
  "task_target",
  "task_assignee",
  "task_assignee_machine",
  "task_stale_after_seconds",
  "task_depends_on",
  "task_parent",
  "task_requires",
  "task_max_attempts",
  "task_attempt",
  "task_claimant_capabilities",
  "task_origin_source",
  "task_origin_conversation",
  "task_origin_message",
  "task_origin_thread",
  "task_origin_requester",
  "task_origin_url",
  "task_mandate_strength",
  "task_mandate_via",
  "task_mandate_policy",
] as const;

const TASK_WIRE_KEY_SET = new Set<string>(TASK_WIRE_KEYS);
const MAX_TASK_STALE_AFTER_SECONDS = 365 * 24 * 60 * 60;

function requiredString(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MalformedMessageError(`header field ${key} must be a non-empty string`, source);
  }
  return value;
}

function optionalAgent(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !isAgentId(value)) {
    throw new MalformedMessageError(`header field ${key} must be a valid agent id`, source);
  }
  return value;
}

/**
 * A task target: an agent id, or a `machine:<id>` token.
 *
 * Separate from `optionalAgent` because `task_assignee` is always one concrete
 * agent — a machine can be addressed but cannot do work — and collapsing the
 * two would let `task_assignee: machine:x` onto the wire.
 */
function optionalTarget(
  raw: Record<string, unknown>,
  key: string,
  source: string | undefined,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!isTaskTarget(value)) {
    throw new MalformedMessageError(
      `header field ${key} must be an agent id or a machine:<id> token`,
      source,
    );
  }
  return value;
}

export function isTaskTarget(value: unknown): value is string {
  return typeof value === "string" && (isAgentId(value) || isMachineToken(value));
}

/** The machine a target names, or null when it names an agent or nothing. */
export function taskTargetMachine(target: string | undefined): string | null {
  return target === undefined ? null : machineFromToken(target);
}

function validateTitle(title: string, source?: string): void {
  if (title.trim().length === 0 || title.length > 200 || /[\r\n]/.test(title)) {
    throw new MalformedMessageError(
      "header field task_title must be one non-empty line of at most 200 characters",
      source,
    );
  }
}

function validateStaleAfter(value: unknown, source?: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > MAX_TASK_STALE_AFTER_SECONDS
  ) {
    throw new MalformedMessageError(
      `header field task_stale_after_seconds must be an integer from 60 to ${String(MAX_TASK_STALE_AFTER_SECONDS)}`,
      source,
    );
  }
  return value;
}

/** A capability a task may require: `[a-z][a-z0-9-]{0,31}`. */
export function isTaskCapability(value: unknown): value is string {
  return typeof value === "string" && TASK_CAPABILITY_PATTERN.test(value);
}

/**
 * An optional list of distinct strings.
 *
 * An empty list reads as absent, so `[]` and a missing key mean the same thing
 * and a snapshot has exactly one wire form.
 */
function optionalSet(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  valid: (value: unknown) => boolean,
  what: string,
  source: string | undefined,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every(valid)) {
    throw new MalformedMessageError(`header field ${key} must be a list of ${what}`, source);
  }
  if (value.length > max) {
    throw new MalformedMessageError(
      `header field ${key} must have at most ${String(max)} entries`,
      source,
    );
  }
  if (new Set(value).size !== value.length) {
    throw new MalformedMessageError(`header field ${key} must not repeat an entry`, source);
  }
  return value.length === 0 ? undefined : [...(value as string[])];
}

function optionalInteger(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  source: string | undefined,
): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new MalformedMessageError(
      `header field ${key} must be an integer from ${String(min)} to ${String(max)}`,
      source,
    );
  }
  return value;
}

function isUlidString(value: unknown): boolean {
  return typeof value === "string" && isUlid(value);
}

function assertResultShape(task: Task, source?: string): void {
  const expectedStates: Partial<Record<TaskAction, readonly TaskState[]>> = {
    created: ["open"],
    retargeted: ["open"],
    claimed: ["claimed"],
    started: ["in_progress"],
    progressed: ["in_progress"],
    blocked: ["blocked"],
    stuck: ["stuck"],
    released: ["open"],
    completed: ["completed"],
    cancelled: ["cancelled"],
    reopened: ["open"],
  };
  const allowed = expectedStates[task.action];
  if (allowed !== undefined && !allowed.includes(task.state)) {
    throw new MalformedMessageError(
      `task action '${task.action}' cannot produce state '${task.state}'`,
      source,
    );
  }

  const requiresAssignee = ["claimed", "in_progress", "blocked", "stuck", "completed"].includes(
    task.state,
  );
  const forbidsAssignee = task.state === "open";
  if (
    (requiresAssignee && task.assignee === undefined) ||
    (forbidsAssignee && task.assignee !== undefined)
  ) {
    throw new MalformedMessageError(
      `task state '${task.state}' ${requiresAssignee ? "requires" : "does not allow"} task_assignee`,
      source,
    );
  }
  // A machine target is deliberately exempt: it names the computer the work
  // belongs to, and the assignee is whichever agent on it took the task.
  const targetMachine = taskTargetMachine(task.target);
  if (
    task.target !== undefined &&
    task.assignee !== undefined &&
    task.target !== task.assignee &&
    targetMachine === null
  ) {
    throw new MalformedMessageError("task_assignee must match task_target", source);
  }
  // The claimer's machine is meaningful only as the answer to "does this
  // claimer satisfy the machine target". Allowing it anywhere else would let an
  // event carry a machine claim nothing ever checks.
  if (task.assigneeMachine !== undefined && task.assignee === undefined) {
    throw new MalformedMessageError("task_assignee_machine requires task_assignee", source);
  }
  if (task.assigneeMachine !== undefined && task.assigneeMachine !== targetMachine) {
    throw new MalformedMessageError(
      "task_assignee_machine must be the machine named by task_target",
      source,
    );
  }
  if (targetMachine !== null && task.assignee !== undefined && task.assigneeMachine === undefined) {
    throw new MalformedMessageError(
      "claiming a machine-targeted task must record task_assignee_machine",
      source,
    );
  }
  // Graph links name other tasks; a task that named itself would wait forever.
  if (task.dependsOn?.includes(task.id) === true) {
    throw new MalformedMessageError("task_depends_on must not name the task itself", source);
  }
  if (task.parent === task.id) {
    throw new MalformedMessageError("task_parent must not name the task itself", source);
  }
  // Same reasoning as task_assignee_machine: the claimant's capabilities answer
  // "does this claimer satisfy task_requires", and nothing else.
  if (task.claimantCapabilities !== undefined) {
    if (task.assignee === undefined) {
      throw new MalformedMessageError("task_claimant_capabilities requires task_assignee", source);
    }
    if (task.requires === undefined) {
      throw new MalformedMessageError("task_claimant_capabilities requires task_requires", source);
    }
  }
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function isTaskAction(value: unknown): value is TaskAction {
  return typeof value === "string" && (TASK_ACTIONS as readonly string[]).includes(value);
}

export function isTaskUpdateAction(value: unknown): value is TaskUpdateAction {
  return typeof value === "string" && (TASK_UPDATE_ACTIONS as readonly string[]).includes(value);
}

export function isTerminalTaskState(value: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(value);
}

export function createTask(input: NewTaskInput): Task {
  const raw: Record<string, unknown> = {
    task_id: input.id,
    task_state: "open",
    task_action: "created",
    task_creator: input.creator,
    task_title: input.title,
    task_stale_after_seconds: input.staleAfterSeconds ?? DEFAULT_TASK_STALE_AFTER_SECONDS,
    ...(input.target === undefined ? {} : { task_target: input.target }),
    ...(input.dependsOn === undefined ? {} : { task_depends_on: [...input.dependsOn] }),
    ...(input.parent === undefined ? {} : { task_parent: input.parent }),
    ...(input.requires === undefined ? {} : { task_requires: [...input.requires] }),
    ...(input.maxAttempts === undefined ? {} : { task_max_attempts: input.maxAttempts }),
    ...(input.origin === undefined ? {} : originToWire(input.origin)),
    ...(input.mandate === undefined
      ? {}
      : {
          task_mandate_strength: input.mandate.strength,
          task_mandate_via: input.mandate.via,
          task_mandate_policy: input.mandate.policy,
        }),
  };
  return parseTask(raw) as Task;
}

export function parseTask(raw: Record<string, unknown>, source?: string): Task | undefined {
  const present = TASK_WIRE_KEYS.filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (present.length === 0) return undefined;

  const id = requiredString(raw, "task_id", source);
  if (!isUlid(id)) {
    throw new MalformedMessageError(`header field task_id is not a ULID: ${id}`, source);
  }
  const state = raw["task_state"];
  if (!isTaskState(state)) {
    throw new MalformedMessageError(
      `header field task_state must be one of: ${TASK_STATES.join(", ")}`,
      source,
    );
  }
  const action = raw["task_action"];
  if (!isTaskAction(action)) {
    throw new MalformedMessageError(
      `header field task_action must be one of: ${TASK_ACTIONS.join(", ")}`,
      source,
    );
  }
  const creator = requiredString(raw, "task_creator", source);
  if (!isAgentId(creator)) {
    throw new MalformedMessageError("header field task_creator must be a valid agent id", source);
  }
  const title = requiredString(raw, "task_title", source);
  validateTitle(title, source);
  const target = optionalTarget(raw, "task_target", source);
  const assignee = optionalAgent(raw, "task_assignee", source);
  const assigneeMachineRaw = raw["task_assignee_machine"];
  let assigneeMachine: string | undefined;
  if (assigneeMachineRaw !== undefined && assigneeMachineRaw !== null) {
    if (typeof assigneeMachineRaw !== "string" || !isMachineId(assigneeMachineRaw)) {
      throw new MalformedMessageError(
        "header field task_assignee_machine must be a valid machine id",
        source,
      );
    }
    assigneeMachine = assigneeMachineRaw;
  }
  const staleAfterSeconds = validateStaleAfter(raw["task_stale_after_seconds"], source);
  const dependsOn = optionalSet(
    raw,
    "task_depends_on",
    MAX_TASK_DEPENDENCIES,
    isUlidString,
    "task ULIDs",
    source,
  );
  const parentRaw = raw["task_parent"];
  if (parentRaw !== undefined && parentRaw !== null && !isUlidString(parentRaw)) {
    throw new MalformedMessageError("header field task_parent must be a task ULID", source);
  }
  const parent = parentRaw === undefined || parentRaw === null ? undefined : (parentRaw as string);
  const requires = optionalSet(
    raw,
    "task_requires",
    MAX_TASK_REQUIRES,
    isTaskCapability,
    "capability names ([a-z][a-z0-9-]{0,31})",
    source,
  );
  const maxAttempts = optionalInteger(raw, "task_max_attempts", 1, MAX_TASK_ATTEMPTS, source);
  const attempt = optionalInteger(raw, "task_attempt", 0, Number.MAX_SAFE_INTEGER, source);
  const claimantCapabilities = optionalSet(
    raw,
    "task_claimant_capabilities",
    MAX_CLAIMANT_CAPABILITIES,
    isTaskCapability,
    "capability names ([a-z][a-z0-9-]{0,31})",
    source,
  );

  const task: Task = {
    id,
    state,
    action,
    creator,
    title,
    staleAfterSeconds,
    ...(target === undefined ? {} : { target }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(assigneeMachine === undefined ? {} : { assigneeMachine }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(parent === undefined ? {} : { parent }),
    ...(requires === undefined ? {} : { requires }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    // Zero is the starting count and is written as absent, so a task that was
    // never claimed has exactly the wire form it had before attempts existed.
    ...(attempt === undefined || attempt === 0 ? {} : { attempt }),
    ...(claimantCapabilities === undefined ? {} : { claimantCapabilities }),
  };
  const origin = parseOrigin(raw, source);
  if (origin !== undefined) task.origin = origin;
  const mandate = parseMandate(raw, source);
  if (mandate !== undefined) task.mandate = mandate;
  assertResultShape(task, source);
  return task;
}

const ORIGIN_KEYS = [
  "task_origin_source",
  "task_origin_conversation",
  "task_origin_message",
  "task_origin_thread",
  "task_origin_requester",
  "task_origin_url",
] as const;

function originField(
  raw: Record<string, unknown>,
  key: string,
  required: boolean,
  source: string | undefined,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (required) throw new MalformedMessageError(`header field ${key} is required`, source);
    return undefined;
  }
  if (!isExternalField(value)) {
    throw new MalformedMessageError(
      `header field ${key} must be a single-line string of at most 256 characters`,
      source,
    );
  }
  return value;
}

function parseOrigin(raw: Record<string, unknown>, source?: string): TaskOrigin | undefined {
  if (ORIGIN_KEYS.every((key) => raw[key] === undefined || raw[key] === null)) return undefined;
  const from = raw["task_origin_source"];
  if (!isExternalSource(from)) {
    throw new MalformedMessageError(
      "header field task_origin_source must match [a-z][a-z0-9-]{0,31}",
      source,
    );
  }
  const thread = originField(raw, "task_origin_thread", false, source);
  const url = originField(raw, "task_origin_url", false, source);
  if (url !== undefined && !/^https?:\/\//.test(url)) {
    throw new MalformedMessageError("header field task_origin_url must be an http(s) URL", source);
  }
  return {
    source: from,
    conversation: originField(raw, "task_origin_conversation", true, source) as string,
    message: originField(raw, "task_origin_message", true, source) as string,
    requester: originField(raw, "task_origin_requester", true, source) as string,
    ...(thread === undefined ? {} : { thread }),
    ...(url === undefined ? {} : { url }),
  };
}

function parseMandate(raw: Record<string, unknown>, source?: string): TaskMandate | undefined {
  const strength = raw["task_mandate_strength"];
  const via = raw["task_mandate_via"];
  const policy = raw["task_mandate_policy"];
  if ([strength, via, policy].every((value) => value === undefined || value === null)) {
    return undefined;
  }
  if (
    typeof strength !== "string" ||
    !(MANDATE_STRENGTHS as readonly string[]).includes(strength)
  ) {
    throw new MalformedMessageError(
      `header field task_mandate_strength must be one of: ${MANDATE_STRENGTHS.join(", ")}`,
      source,
    );
  }
  if (typeof via !== "string" || !(MANDATE_VIA as readonly string[]).includes(via)) {
    throw new MalformedMessageError(
      `header field task_mandate_via must be one of: ${MANDATE_VIA.join(", ")}`,
      source,
    );
  }
  if (typeof policy !== "string" || !/^[0-9a-f]{8,64}$/.test(policy)) {
    throw new MalformedMessageError(
      "header field task_mandate_policy must be 8 to 64 lowercase hex characters",
      source,
    );
  }
  return {
    strength: strength as MandateStrength,
    via: via as MandateVia,
    policy,
  };
}

function originToWire(origin: TaskOrigin): Record<string, unknown> {
  return {
    task_origin_source: origin.source,
    task_origin_conversation: origin.conversation,
    task_origin_message: origin.message,
    ...(origin.thread === undefined ? {} : { task_origin_thread: origin.thread }),
    task_origin_requester: origin.requester,
    ...(origin.url === undefined ? {} : { task_origin_url: origin.url }),
  };
}

function sameOrigin(left: TaskOrigin | undefined, right: TaskOrigin | undefined): boolean {
  return (
    JSON.stringify(left === undefined ? null : originToWire(left)) ===
    JSON.stringify(right === undefined ? null : originToWire(right))
  );
}

function sameMandate(left: TaskMandate | undefined, right: TaskMandate | undefined): boolean {
  return (
    left?.strength === right?.strength && left?.via === right?.via && left?.policy === right?.policy
  );
}

export function taskToWire(task: Task): Record<string, unknown> {
  return {
    task_id: task.id,
    task_state: task.state,
    task_action: task.action,
    task_creator: task.creator,
    task_title: task.title,
    ...(task.target === undefined ? {} : { task_target: task.target }),
    ...(task.assignee === undefined ? {} : { task_assignee: task.assignee }),
    ...(task.assigneeMachine === undefined ? {} : { task_assignee_machine: task.assigneeMachine }),
    task_stale_after_seconds: task.staleAfterSeconds,
    ...(task.dependsOn === undefined || task.dependsOn.length === 0
      ? {}
      : { task_depends_on: [...task.dependsOn] }),
    ...(task.parent === undefined ? {} : { task_parent: task.parent }),
    ...(task.requires === undefined || task.requires.length === 0
      ? {}
      : { task_requires: [...task.requires] }),
    ...(task.maxAttempts === undefined ? {} : { task_max_attempts: task.maxAttempts }),
    ...(task.attempt === undefined || task.attempt === 0 ? {} : { task_attempt: task.attempt }),
    ...(task.claimantCapabilities === undefined || task.claimantCapabilities.length === 0
      ? {}
      : { task_claimant_capabilities: [...task.claimantCapabilities] }),
    ...(task.origin === undefined ? {} : originToWire(task.origin)),
    ...(task.mandate === undefined
      ? {}
      : {
          task_mandate_strength: task.mandate.strength,
          task_mandate_via: task.mandate.via,
          task_mandate_policy: task.mandate.policy,
        }),
  };
}

export function isTaskWireKey(value: string): boolean {
  return TASK_WIRE_KEY_SET.has(value);
}

/** Validate the first append-only event of a task. */
export function assertInitialTask(task: Task, author: string): void {
  if (task.action !== "created" || task.state !== "open") {
    throw new TaskTransitionError("the first task event must be action 'created' in state 'open'");
  }
  if (task.assignee !== undefined) {
    throw new TaskTransitionError("a new task cannot already have an assignee");
  }
  if (task.attempt !== undefined) {
    throw new TaskTransitionError("a new task cannot already have attempts");
  }
  if (author !== task.creator) {
    throw new TaskTransitionError("only the declared creator can create a task");
  }
}

function assertUnchanged(condition: boolean, message: string): void {
  if (!condition) throw new TaskTransitionError(message);
}

function sameList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Everything fixed at creation.
 *
 * The graph fields are here so a refinement cannot quietly drop a dependency
 * or a requirement. It also means a client too old to know them, which writes
 * a snapshot without them, has its events rejected rather than accepted with
 * the constraint gone.
 */
function sameIdentity(previous: Task, next: Task): boolean {
  return (
    previous.id === next.id &&
    previous.creator === next.creator &&
    previous.staleAfterSeconds === next.staleAfterSeconds &&
    sameList(previous.dependsOn, next.dependsOn) &&
    previous.parent === next.parent &&
    sameList(previous.requires, next.requires) &&
    previous.maxAttempts === next.maxAttempts &&
    sameOrigin(previous.origin, next.origin) &&
    sameMandate(previous.mandate, next.mandate)
  );
}

function sameAssignment(previous: Task, next: Task): boolean {
  return (
    previous.target === next.target &&
    previous.assignee === next.assignee &&
    previous.assigneeMachine === next.assigneeMachine &&
    sameList(previous.claimantCapabilities, next.claimantCapabilities)
  );
}

/** The attempt counter after `next` is accepted on top of `previous`. */
export function nextTaskAttempt(previous: Task, next: Task): number {
  const attempt = previous.attempt ?? 0;
  return next.action === "claimed" ? attempt + 1 : attempt;
}

/** Whether a task still has a claim left under `maxAttempts`. */
export function hasTaskAttemptsLeft(task: Task): boolean {
  return task.maxAttempts === undefined || (task.attempt ?? 0) < task.maxAttempts;
}

/**
 * Validate a claim against the state of the task's dependencies.
 *
 * `stateOf` answers for the same point in the room's canonical order as the
 * claim, which is what makes the verdict identical on every machine: a reader
 * that fetched the completion later still orders it the same way. Undefined
 * means the room does not carry that task.
 */
export function assertDependenciesMet(
  task: Task,
  stateOf: (id: string) => TaskState | undefined,
): void {
  const pending: string[] = [];
  for (const id of task.dependsOn ?? []) {
    const state = stateOf(id);
    if (state !== "completed") pending.push(`${id} (${state ?? "missing"})`);
  }
  if (pending.length > 0) {
    throw new TaskTransitionError(
      `dependencies are not completed: ${pending.join(", ")}`,
      "DEPENDENCY_PENDING",
    );
  }
}

/**
 * Validate one task event against the latest accepted task snapshot.
 *
 * Pure, and deliberately reads nothing outside the two snapshots and the
 * author: this runs in the reducer on every machine, and a verdict that
 * depended on local state would let two machines disagree about who owns a
 * task. A machine-targeted claim is therefore checked against
 * `task_assignee_machine` carried on the event itself — self-asserted, like
 * `from`, and identical wherever it is read.
 */
export function assertTaskTransition(previous: Task, next: Task, author: string): void {
  assertUnchanged(
    sameIdentity(previous, next),
    "task id, creator, stale threshold, dependencies, parent, requirements, attempt limit, origin, and mandate are immutable",
  );
  if (next.action !== "refined") {
    assertUnchanged(previous.title === next.title, "only a refinement may change the task title");
  }
  if (next.action !== "retargeted") {
    assertUnchanged(previous.target === next.target, "only the creator may retarget an open task");
  }
  // An absent counter is accepted: every event written before attempts existed
  // omits it, and the reader derives the count from the log either way.
  const attempt = nextTaskAttempt(previous, next);
  if (next.attempt !== undefined) {
    assertUnchanged(
      next.attempt === attempt,
      `task_attempt must be ${String(attempt)} after '${next.action}'`,
    );
  }

  switch (next.action) {
    case "created":
      throw new TaskTransitionError("a task can have only one creation event");
    case "refined":
      assertUnchanged(!isTerminalTaskState(previous.state), "a terminal task cannot be refined");
      assertUnchanged(previous.state === next.state, "a refinement cannot change task state");
      assertUnchanged(sameAssignment(previous, next), "a refinement cannot change assignment");
      return;
    case "retargeted":
      assertUnchanged(author === previous.creator, "only the task creator may retarget it");
      assertUnchanged(
        previous.state === "open" && next.state === "open",
        "only an open task can be retargeted",
      );
      assertUnchanged(
        previous.assignee === undefined && next.assignee === undefined,
        "a claimed task must be released before retargeting",
      );
      assertUnchanged(previous.target !== next.target, "retargeting must change the target");
      return;
    case "claimed":
      assertUnchanged(
        previous.state === "open" && next.state === "claimed",
        // Naming the holder matters more since work can be offered to a whole
        // machine: two sessions on one box racing for the same task is the
        // ordinary case now, and the loser's next move depends on who won.
        previous.assignee === undefined
          ? `a task in state '${previous.state}' cannot be claimed`
          : `already claimed by ${previous.assignee}`,
      );
      assertUnchanged(previous.assignee === undefined, "the task is already assigned");
      assertUnchanged(next.assignee === author, "an agent may claim a task only for itself");
      {
        // Both sides must actually be machines. Comparing a null target machine
        // against an absent claimer machine reads as "equal" and would let any
        // agent take over work targeted at a named colleague.
        const targetMachine = taskTargetMachine(previous.target);
        assertUnchanged(
          previous.target === undefined ||
            previous.target === author ||
            (targetMachine !== null && targetMachine === next.assigneeMachine),
          targetMachine === null
            ? "this task is targeted to another agent"
            : `this task is targeted to ${previous.target as string}, not to this machine`,
        );
      }
      if (!hasTaskAttemptsLeft(previous)) {
        throw new TaskTransitionError(
          `all ${String(previous.maxAttempts)} attempt(s) are used; the creator must decide what happens next`,
          "ATTEMPTS_EXHAUSTED",
        );
      }
      {
        const declared = next.claimantCapabilities ?? [];
        const missing = (previous.requires ?? []).filter((name) => !declared.includes(name));
        if (missing.length > 0) {
          throw new TaskTransitionError(
            `the claimant does not declare required capabilities: ${missing.join(", ")}`,
            "CAPABILITY_MISSING",
          );
        }
      }
      return;
    case "started":
      assertUnchanged(
        ["claimed", "blocked", "stuck"].includes(previous.state) && next.state === "in_progress",
        "a task starts from claimed, blocked, or stuck",
      );
      break;
    case "progressed":
      assertUnchanged(
        previous.state === "in_progress" && next.state === "in_progress",
        "progress requires an in-progress task",
      );
      break;
    case "blocked":
      assertUnchanged(
        ["claimed", "in_progress"].includes(previous.state) && next.state === "blocked",
        "only a claimed or in-progress task can be blocked",
      );
      break;
    case "stuck":
      assertUnchanged(
        ["in_progress", "blocked"].includes(previous.state) && next.state === "stuck",
        "a task becomes stuck from in-progress or blocked",
      );
      break;
    case "released":
      assertUnchanged(
        ["claimed", "in_progress", "blocked", "stuck"].includes(previous.state) &&
          next.state === "open",
        "only an active task can be released back to open",
      );
      assertUnchanged(
        author === previous.assignee || author === previous.creator,
        "only the assignee or creator may release a task",
      );
      assertUnchanged(
        next.assignee === undefined && next.assigneeMachine === undefined,
        "a released task must clear its assignee",
      );
      return;
    case "completed":
      assertUnchanged(
        previous.state === "in_progress" && next.state === "completed",
        "a task completes only from in-progress",
      );
      break;
    case "cancelled":
      assertUnchanged(!isTerminalTaskState(previous.state), "the task is already terminal");
      assertUnchanged(next.state === "cancelled", "cancelling must produce state 'cancelled'");
      assertUnchanged(author === previous.creator, "only the task creator may cancel it");
      assertUnchanged(sameAssignment(previous, next), "cancelling cannot change assignment");
      return;
    case "reopened":
      assertUnchanged(
        isTerminalTaskState(previous.state) && next.state === "open",
        "only a terminal task can be reopened",
      );
      assertUnchanged(author === previous.creator, "only the task creator may reopen it");
      assertUnchanged(next.assignee === undefined, "a reopened task must be claimed again");
      return;
  }

  assertUnchanged(
    sameAssignment(previous, next),
    `task action '${next.action}' cannot change assignment`,
  );
  assertUnchanged(
    author === previous.assignee,
    `only assignee ${previous.assignee ?? "<none>"} may mark a task '${next.action}'`,
  );
}
