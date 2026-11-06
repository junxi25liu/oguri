import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { MAX_TASK_REQUIRES, isAgentId, isTaskCapability } from "@oguri/protocol";

import type { Layout } from "./layout.ts";
// --- notifications (ADR 0028) ---
import {
  DEFAULT_NOTIFICATION_POLICY,
  parseNotificationPolicy,
  type NotificationPolicy,
} from "./notification-policy.ts";
// --- end notifications ---
import { EFFORT_NAME, MODEL_NAME, runnerFlavor } from "./runner-model.ts";
// --- intake (ADR 0030) ---
import { DEFAULT_INTAKE_POLICY, parseIntakePolicy, type IntakePolicy } from "./intake-policy.ts";
// --- end intake ---
// --- superagent (ADR 0031) ---
import {
  DEFAULT_SUPERAGENT_POLICY,
  MAX_RUN_CONCURRENCY,
  parseSuperagentPolicy,
  type SuperagentPolicy,
} from "./superagent-policy.ts";
// --- end superagent ---

// The ceiling both `worker.concurrency` and `superagent.small.maxWorkers` use.
export { MAX_RUN_CONCURRENCY };

/**
 * Machine-local operating policy — the file a person edits by hand.
 *
 * Deliberately NOT part of `config.yaml`. That file is rewritten by oguri
 * itself on `room join`, `room leave`, and every daemon
 * subscription change, and rewriting round-trips through the YAML serialiser —
 * so comments, ordering, and anything else a human put there are destroyed the
 * next time a room is joined. A file people are asked to edit must be one the
 * tool never writes.
 *
 * Also distinct from the two shared policies, which are a different thing
 * entirely: `.oguri/policy.yaml` **inside the transport repository** is
 * network-wide and applies to everyone (spec §8), and `room.yaml` carries
 * per-room policy. Both are shared state, agreed by the team. This one is
 * local: it answers "how must MY agent behave on MY machine", which is nobody
 * else's decision — and, critically, is not something a remote peer can set.
 */

/** When a person must approve before this agent takes on delegated work. */
export const APPROVAL_MODES = ["never", "remote", "always"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Where a piece of delegated work came from, as decided by local data only. */
export type WorkOrigin = "local" | "remote";

export interface ApprovalPolicy {
  /**
   * Approval required before claiming work someone delegated.
   *
   * - `never` — take any work without asking. Fully autonomous.
   * - `remote` — ask only for work delegated from another machine. Default.
   * - `always` — ask even for work this agent or a local agent created.
   */
  inboundWork: ApprovalMode;
  /**
   * Agents whose delegations count as `local`.
   *
   * This agent is always local and never needs listing. Everything else is
   * remote until named here, and it is named **here**, in a local file,
   * rather than derived from the agent card: a card is written by the machine
   * it describes, so a peer could declare itself local and walk through the
   * gate that exists to keep its requests under a person's control.
   */
  localAgents: string[];
}

/** What the worker does with a task whose run died with the worker (ADR 0026). */
export const ABANDON_ACTIONS = ["release", "block"] as const;
export type AbandonAction = (typeof ABANDON_ACTIONS)[number];

/** What the worker does with a task whose run failed (ADR 0026). */
export const RETRY_ACTIONS = ["release", "block"] as const;
export type RetryAction = (typeof RETRY_ACTIONS)[number];

/**
 * How a failed run is handed on.
 *
 * Without `onFailure`, a task that still has attempts left under its
 * `maxAttempts` is released for another try, and a task without a limit is
 * blocked: an unbounded task that is released after every failure would be
 * retried for as long as the hourly cap allows.
 */
export interface WorkerRetryPolicy {
  onFailure?: RetryAction;
  /** Minutes this machine waits before it takes a task it released back again. */
  backoffMinutes: number;
}

/**
 * How the worker learns a run's agent session id, so a follow-up can resume it (ADR 0030).
 *
 * - `claude-json`: stdout is one JSON object; `session_id` is the id and
 *   `result` is the final text (`claude -p --output-format json`).
 * - `codex-jsonl`: stdout is JSON lines; the first `thread.started` event's
 *   `thread_id`, or a `session_id`, is the id (`codex exec --json`).
 * - `file`: the agent writes the id to `$OGURI_SESSION_FILE` in its run directory.
 * - `claude-stream`: a live session (ADR 0032). The runner takes
 *   `--input-format stream-json --output-format stream-json --verbose`; the
 *   worker keeps its stdin open and writes a person's message into the running
 *   session as soon as it arrives, as a live superagent steers a worker's inbox.
 */
export const SESSION_MODES = ["claude-json", "codex-jsonl", "file", "claude-stream"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** The token a runner's `resume` argv carries where the session id goes. */
export const SESSION_TOKEN = "{session}";

/**
 * One allow-listed executor.
 *
 * In the policy file a runner is either a bare argv list or a mapping with
 * `argv`, `model`, `workdir`, `worktree`, `resume`, `session`, and
 * `oguriTools`. The parser turns both into this shape.
 */
export interface WorkerRunner {
  /** Run with no shell. */
  argv: string[];
  /**
   * Model a `claude` or `codex` argv should use. The worker, superagents, and
   * planner add `--model <m>` or `-m <m>` unless the argv already chose one.
   */
  model?: string;
  /**
   * Reasoning effort a `claude` argv should use. Added as `--effort <level>`
   * unless the argv already chose one. Only `claude` understands the flag, so
   * setting this on any other command is an error rather than a silent no-op.
   */
  effort?: string;
  /**
   * The only effort levels a task may ask for on this runner, by first line.
   *
   * Empty or absent means a task cannot change the effort at all: the runner
   * uses `effort`, or whatever its argv already chose. This is an allow-list of
   * values written by the machine owner, never a value from the network.
   */
  efforts?: string[];
  /** Directory this runner starts in. Overrides `worker.workdir`. */
  workdir?: string;
  /**
   * Run in a fresh git worktree of `workdir`, under the run's own directory,
   * so two runs never share a checkout. The worktree stays after the run.
   */
  worktree: boolean;
  /**
   * Argv that continues an earlier session, with `{session}` exactly once
   * where the id goes. Also run with no shell. Requires `session`.
   */
  resume?: string[];
  /** Where the session id of a run comes from. */
  session?: SessionMode;
  /**
   * Give the run oguri's own tools (ADR 0032): the worker adds oguri's MCP
   * server to a `claude` or `codex` argv, so the agent can report progress,
   * ask a person, and hand work back while it runs. Defaults to on for those
   * two; false leaves the argv exactly as written.
   */
  oguriTools?: boolean;
  /**
   * The runner follows the `result.json` protocol: a run that exits 0 without
   * writing the file is not a completion, and goes through the retry rules.
   * Absent or false keeps the older behaviour for runners with no such
   * protocol (a chat runner): the run completes and the report says no file
   * was written.
   */
  requireResult?: boolean;
}

/**
 * One tier of runners: a named rung on the cost ladder (ADR 0034).
 *
 * Tiers only group runners the owner already listed under `worker.runners`;
 * they add no command and no argument. A superagent picks a tier by how hard
 * and risky a task is, and a task names it on its header line `tier: <name>`.
 */
export interface WorkerTier {
  name: string;
  /** Entries of `worker.runners`, preferred first. Never empty. */
  runners: string[];
  /** Effort a task in this tier runs at unless it names one. On every runner's `efforts`. */
  effort?: string;
}

/**
 * How far a failed task may climb the tiers.
 *
 * A failed run that is released for another try moves its task one tier up,
 * at most `maxSteps` times in the task's life. 0 turns climbing off.
 */
export interface WorkerEscalationPolicy {
  maxSteps: number;
}

/**
 * Whether this machine runs assigned tasks unattended, and within what limits.
 *
 * Read only by `@oguri/worker` (ADR 0026). It lives in this file and nowhere
 * else, so the person who owns the machine and pays for the
 * agent plan is the only one who can turn it on. A task may ask for a runner by
 * name, but it can only pick from `runners`; the argv itself never comes from
 * the network.
 */
export interface WorkerPolicy {
  enabled: boolean;
  /**
   * Runs allowed at the same time, as this worker is configured.
   *
   * The value actually in force is `effectiveConcurrency`, which a small
   * superagent's `maxWorkers` replaces while that role is on. Status output
   * reads that, so a machine never reports a number it is not running.
   */
  concurrency: number;
  /** Runs started per rolling hour. */
  maxPerHour: number;
  /** A run past this is killed and its task moves to `blocked`. */
  timeoutMinutes: number;
  /** Directory each run starts in. `~` expands to the home directory. Defaults to the home directory. */
  workdir?: string;
  /** Allow-listed executors, by name. */
  runners: Record<string, WorkerRunner>;
  /** Runner used when a task names none. Defaults to the first entry of `runners`. */
  defaultRunner?: string;
  /**
   * Runner `oguri plan` uses to break a goal into tasks, when `--runner` is
   * not given. Falls back to `defaultRunner`. Must name an entry of `runners`.
   */
  plannerRunner?: string;
  /**
   * Agents whose remote tasks the worker approves on its own.
   *
   * Anyone else still waits for `oguri task approve`. Each auto-approval is
   * written to the same local approval record a person's approval is.
   */
  trustedRequesters: string[];
  /**
   * What happens to a task whose run was cut off by a crash or a forced stop.
   * `release` hands it back so another machine may take it; `block` leaves it
   * with this agent for a person to look at.
   */
  onAbandon: AbandonAction;
  /**
   * Task capabilities this worker asserts (ADR 0027). Free tasks that require
   * only these are claimed as well as tasks offered here, and the names are
   * added to this agent's profile so planners can see them.
   */
  capabilities: string[];
  /** What happens to a task whose run failed. */
  retry: WorkerRetryPolicy;
  /**
   * Days after this worker completed a task during which a person's follow-up
   * in its thread still runs it again (ADR 0030). 0 turns that off; follow-ups
   * on tasks that are not finished are always taken.
   */
  followupDays: number;
  /**
   * Runner tiers, cheapest first (ADR 0034). Empty means none: tasks pick a
   * runner by name, as before.
   */
  tiers: WorkerTier[];
  /** How far a failed task may climb `tiers`. */
  escalation: WorkerEscalationPolicy;
  /**
   * How many parents a subtask created inside a run may have (ADR 0036). 0 means
   * a run creates no subtasks. What a run creates runs here with no approval, so
   * this is what bounds a run fanning out into more runs.
   */
  maxTaskDepth: number;
}

export interface LocalPolicy {
  v: number;
  approvals: ApprovalPolicy;
  worker: WorkerPolicy;
  // --- notifications (ADR 0028) ---
  notifications: NotificationPolicy;
  // --- end notifications ---
  // --- intake (ADR 0030) ---
  intake: IntakePolicy;
  // --- end intake ---
  // --- superagent (ADR 0031) ---
  superagent: SuperagentPolicy;
  // --- end superagent ---
}

export const DEFAULT_WORKER_POLICY: WorkerPolicy = {
  enabled: false,
  concurrency: 1,
  maxPerHour: 6,
  timeoutMinutes: 180,
  runners: {},
  trustedRequesters: [],
  onAbandon: "release",
  capabilities: [],
  retry: { backoffMinutes: 10 },
  followupDays: 14,
  tiers: [],
  escalation: { maxSteps: 0 },
  maxTaskDepth: 2,
};

/** A fresh copy, so no caller can mutate the shared default through a nested value. */
function defaultWorkerPolicy(): WorkerPolicy {
  return {
    ...DEFAULT_WORKER_POLICY,
    runners: {},
    trustedRequesters: [],
    capabilities: [],
    retry: { ...DEFAULT_WORKER_POLICY.retry },
    tiers: [],
    escalation: { ...DEFAULT_WORKER_POLICY.escalation },
  };
}

export const DEFAULT_LOCAL_POLICY: LocalPolicy = {
  v: 1,
  worker: defaultWorkerPolicy(),
  // --- notifications (ADR 0028) ---
  notifications: { ...DEFAULT_NOTIFICATION_POLICY, channels: [] },
  // --- end notifications ---
  // --- intake (ADR 0030) ---
  intake: { ...DEFAULT_INTAKE_POLICY },
  // --- end intake ---
  // --- superagent (ADR 0031) ---
  superagent: structuredClone(DEFAULT_SUPERAGENT_POLICY),
  // --- end superagent ---
  approvals: {
    // Work delegated from another machine is the case a person should see.
    // Work this agent created for itself is not a delegation at all, and
    // pausing on it would make the gate fire constantly and get switched off.
    inboundWork: "remote",
    localAgents: [],
  },
};

export interface ResolvedPolicy {
  policy: LocalPolicy;
  /** Files that contributed, nearest last. Empty means every value is default. */
  sources: string[];
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Parse a policy file, refusing anything it does not understand.
 *
 * Unknown keys are an error rather than a shrug. This file exists so a person
 * can constrain an agent; silently ignoring a misspelled key would leave them
 * believing a limit is in force when it is not, which is worse than no file.
 */
export function parseLocalPolicy(raw: string, source: string): Partial<LocalPolicy> {
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(source, "policy must be a YAML mapping");
  }
  const root = parsed as Record<string, unknown>;

  for (const key of Object.keys(root)) {
    if (key === "activation") {
      // Removed in favour of the worker (ADR 0026). Failing loudly beats
      // leaving someone to believe a wake-up command is still configured.
      fail(source, "'activation' was removed; use the 'worker' section instead (ADR 0026)");
    }
    if (
      key !== "v" &&
      key !== "approvals" &&
      key !== "worker" &&
      key !== "notifications" &&
      key !== "intake" &&
      key !== "superagent"
    ) {
      fail(
        source,
        `unknown top-level key '${key}'; known keys: v, approvals, worker, notifications, intake, superagent`,
      );
    }
  }
  if (root["v"] !== undefined && root["v"] !== 1) {
    fail(source, `unsupported policy version ${String(root["v"])}; this build understands v: 1`);
  }

  const result: Partial<LocalPolicy> = {};

  if (root["worker"] !== undefined) result.worker = parseWorkerPolicy(root["worker"], source);
  // --- notifications (ADR 0028) ---
  if (root["notifications"] !== undefined) {
    result.notifications = parseNotificationPolicy(root["notifications"], source);
  }
  // --- end notifications ---
  // --- intake (ADR 0030) ---
  if (root["intake"] !== undefined) result.intake = parseIntakePolicy(root["intake"], source);
  // --- end intake ---
  // --- superagent (ADR 0031) ---
  if (root["superagent"] !== undefined) {
    result.superagent = parseSuperagentPolicy(root["superagent"], source);
  }
  // --- end superagent ---

  const approvalsValue = root["approvals"];
  if (approvalsValue === undefined) return result;
  if (
    approvalsValue === null ||
    typeof approvalsValue !== "object" ||
    Array.isArray(approvalsValue)
  )
    fail(source, "'approvals' must be a mapping");
  const approvals = approvalsValue as Record<string, unknown>;

  for (const key of Object.keys(approvals)) {
    if (key !== "inboundWork" && key !== "localAgents") {
      fail(source, `unknown key 'approvals.${key}'; known keys: inboundWork, localAgents`);
    }
  }

  const approvalResult: Partial<ApprovalPolicy> = {};
  const mode = approvals["inboundWork"];
  if (mode !== undefined) {
    if (!isApprovalMode(mode)) {
      fail(
        source,
        `approvals.inboundWork must be one of: ${APPROVAL_MODES.join(", ")} (got ${JSON.stringify(mode)})`,
      );
    }
    approvalResult.inboundWork = mode;
  }

  const local = approvals["localAgents"];
  if (local !== undefined) {
    if (!Array.isArray(local)) fail(source, "approvals.localAgents must be a list of agent ids");
    const ids: string[] = [];
    for (const entry of local) {
      if (typeof entry !== "string" || !isAgentId(entry)) {
        fail(
          source,
          `approvals.localAgents contains an invalid agent id: ${JSON.stringify(entry)}`,
        );
      }
      if (!ids.includes(entry)) ids.push(entry);
    }
    approvalResult.localAgents = ids;
  }

  if (Object.keys(approvalResult).length > 0) {
    result.approvals = approvalResult as ApprovalPolicy;
  }
  return result;
}

const WORKER_KEYS = [
  "enabled",
  "concurrency",
  "maxPerHour",
  "timeoutMinutes",
  "workdir",
  "runners",
  "defaultRunner",
  "plannerRunner",
  "trustedRequesters",
  "onAbandon",
  "capabilities",
  "retry",
  "followupDays",
  "tiers",
  "escalation",
  "maxTaskDepth",
] as const;

const TIER_KEYS = ["runners", "effort"] as const;
const ESCALATION_KEYS = ["maxSteps"] as const;
/** A ladder longer than this is a list of runners, not a set of tiers. */
const MAX_TIERS = 8;

const RUNNER_KEYS = [
  "argv",
  "model",
  "effort",
  "efforts",
  "workdir",
  "worktree",
  "resume",
  "session",
  "oguriTools",
  "requireResult",
] as const;
const RETRY_KEYS = ["onFailure", "backoffMinutes"] as const;

/** Same bound as `task_requires`: a worker asserts no more than a task may ask for. */
const MAX_WORKER_CAPABILITIES = MAX_TASK_REQUIRES;

/** Runner names appear in task text, so keep them to a small, unambiguous alphabet. */
const RUNNER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
  source: string,
): number {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    fail(source, `worker.${name} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return n;
}

function parseWorkerPolicy(value: unknown, source: string): WorkerPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "'worker' must be a mapping");
  }
  const worker = value as Record<string, unknown>;
  for (const key of Object.keys(worker)) {
    if (!(WORKER_KEYS as readonly string[]).includes(key)) {
      fail(source, `unknown key 'worker.${key}'; known keys: ${WORKER_KEYS.join(", ")}`);
    }
  }

  const enabled = worker["enabled"] ?? false;
  if (typeof enabled !== "boolean") fail(source, "worker.enabled must be true or false");

  const runnersValue = worker["runners"] ?? {};
  if (runnersValue === null || typeof runnersValue !== "object" || Array.isArray(runnersValue)) {
    fail(source, "worker.runners must be a mapping of name to argv");
  }
  const runners: Record<string, WorkerRunner> = {};
  for (const [name, entry] of Object.entries(runnersValue as Record<string, unknown>)) {
    if (!RUNNER_NAME.test(name)) {
      fail(
        source,
        `worker.runners has an invalid name '${name}'; use lowercase letters, digits, -`,
      );
    }
    runners[name] = parseRunner(name, entry, source);
  }

  const defaultRunner = worker["defaultRunner"];
  if (
    defaultRunner !== undefined &&
    (typeof defaultRunner !== "string" || !(defaultRunner in runners))
  ) {
    fail(source, "worker.defaultRunner must name an entry of worker.runners");
  }
  const plannerRunner = worker["plannerRunner"];
  if (
    plannerRunner !== undefined &&
    (typeof plannerRunner !== "string" || !(plannerRunner in runners))
  ) {
    fail(source, "worker.plannerRunner must name an entry of worker.runners");
  }
  if (enabled && Object.keys(runners).length === 0) {
    fail(source, "worker.enabled is true but worker.runners is empty");
  }

  const workdir = worker["workdir"];
  if (workdir !== undefined && (typeof workdir !== "string" || workdir.length === 0)) {
    fail(source, "worker.workdir must be a path");
  }
  for (const [name, runner] of Object.entries(runners)) {
    // A worktree of the home directory is never what anyone meant, so the
    // repository has to be named somewhere rather than defaulting to `~`.
    if (runner.worktree && runner.workdir === undefined && workdir === undefined) {
      fail(
        source,
        `worker.runners.${name} sets worktree: true but names no repository; set its workdir or worker.workdir`,
      );
    }
  }

  const onAbandon = worker["onAbandon"] ?? DEFAULT_WORKER_POLICY.onAbandon;
  if (
    typeof onAbandon !== "string" ||
    !(ABANDON_ACTIONS as readonly string[]).includes(onAbandon)
  ) {
    fail(
      source,
      `worker.onAbandon must be one of: ${ABANDON_ACTIONS.join(", ")} (got ${JSON.stringify(onAbandon)})`,
    );
  }

  const trustedValue = worker["trustedRequesters"] ?? [];
  if (!Array.isArray(trustedValue))
    fail(source, "worker.trustedRequesters must be a list of agent ids");
  const trustedRequesters: string[] = [];
  for (const entry of trustedValue) {
    if (typeof entry !== "string" || !isAgentId(entry)) {
      fail(
        source,
        `worker.trustedRequesters contains an invalid agent id: ${JSON.stringify(entry)}`,
      );
    }
    if (!trustedRequesters.includes(entry)) trustedRequesters.push(entry);
  }

  const capabilitiesValue = worker["capabilities"] ?? [];
  if (!Array.isArray(capabilitiesValue)) {
    fail(source, "worker.capabilities must be a list of capability names");
  }
  const capabilities: string[] = [];
  for (const entry of capabilitiesValue) {
    // Free text could never satisfy `task_requires`, so it is refused here
    // rather than published and silently ignored (ADR 0027).
    if (!isTaskCapability(entry)) {
      fail(
        source,
        `worker.capabilities contains an invalid name ${JSON.stringify(entry)}; use lowercase letters, digits, - (up to 32)`,
      );
    }
    if (!capabilities.includes(entry)) capabilities.push(entry);
  }
  if (capabilities.length > MAX_WORKER_CAPABILITIES) {
    fail(
      source,
      `worker.capabilities lists more than ${String(MAX_WORKER_CAPABILITIES)} capabilities`,
    );
  }

  const tiers = parseTiers(worker["tiers"], runners, source);

  return {
    enabled,
    concurrency: boundedInt(
      worker["concurrency"],
      DEFAULT_WORKER_POLICY.concurrency,
      // Ceiled with `superagent.small.maxWorkers`: 20 is enough for a whole
      // machine's pool, and a typo such as 200 is still refused.
      1,
      MAX_RUN_CONCURRENCY,
      "concurrency",
      source,
    ),
    maxPerHour: boundedInt(
      worker["maxPerHour"],
      DEFAULT_WORKER_POLICY.maxPerHour,
      1,
      120,
      "maxPerHour",
      source,
    ),
    timeoutMinutes: boundedInt(
      worker["timeoutMinutes"],
      DEFAULT_WORKER_POLICY.timeoutMinutes,
      1,
      1440,
      "timeoutMinutes",
      source,
    ),
    ...(workdir === undefined ? {} : { workdir: workdir as string }),
    runners,
    ...(defaultRunner === undefined ? {} : { defaultRunner: defaultRunner as string }),
    ...(plannerRunner === undefined ? {} : { plannerRunner: plannerRunner as string }),
    trustedRequesters,
    onAbandon: onAbandon as AbandonAction,
    capabilities,
    retry: parseRetryPolicy(worker["retry"], source),
    followupDays: boundedInt(
      worker["followupDays"],
      DEFAULT_WORKER_POLICY.followupDays,
      0,
      365,
      "followupDays",
      source,
    ),
    tiers,
    escalation: parseEscalation(worker["escalation"], tiers, source),
    maxTaskDepth: boundedInt(
      worker["maxTaskDepth"],
      DEFAULT_WORKER_POLICY.maxTaskDepth,
      0,
      8,
      "maxTaskDepth",
      source,
    ),
  };
}

/**
 * `worker.tiers`: a mapping of tier name to its runners, cheapest tier first.
 *
 * A tier is a runner name, a list of them, or a mapping with `runners` and an
 * optional `effort`. Every name must be an entry of `worker.runners`, and a
 * tier's `effort` must be on the `efforts` list of every runner in it, so a
 * tier can never select a command or a level the owner did not write.
 */
function parseTiers(
  value: unknown,
  runners: Record<string, WorkerRunner>,
  source: string,
): WorkerTier[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "worker.tiers must be a mapping of tier name to runners, cheapest first");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_TIERS) {
    fail(source, `worker.tiers lists more than ${String(MAX_TIERS)} tiers`);
  }
  const tiers: WorkerTier[] = [];
  const placed = new Map<string, string>();
  for (const [name, entry] of entries) {
    const at = `worker.tiers.${name}`;
    // Tier names appear in task text exactly as runner names do.
    if (!RUNNER_NAME.test(name)) {
      fail(source, `worker.tiers has an invalid name '${name}'; use lowercase letters, digits, -`);
    }
    let listed: unknown;
    let effort: unknown;
    if (typeof entry === "string" || Array.isArray(entry)) {
      listed = entry;
    } else if (entry !== null && typeof entry === "object") {
      const tier = entry as Record<string, unknown>;
      for (const key of Object.keys(tier)) {
        if (!(TIER_KEYS as readonly string[]).includes(key)) {
          fail(source, `unknown key '${at}.${key}'; known keys: ${TIER_KEYS.join(", ")}`);
        }
      }
      listed = tier["runners"];
      effort = tier["effort"];
    } else {
      fail(
        source,
        `${at} must be a runner name, a list of runner names, or a mapping with runners`,
      );
    }
    const names = typeof listed === "string" ? [listed] : listed;
    if (!Array.isArray(names) || names.length === 0) {
      fail(source, `${at}.runners must list at least one entry of worker.runners`);
    }
    const members: string[] = [];
    for (const runner of names as unknown[]) {
      if (typeof runner !== "string" || !Object.hasOwn(runners, runner)) {
        fail(
          source,
          `${at} names ${JSON.stringify(runner)}, which is not an entry of worker.runners (${Object.keys(runners).join(", ") || "none"})`,
        );
      }
      // One runner on two rungs would make "one tier up" mean nothing.
      const other = placed.get(runner);
      if (other !== undefined && other !== name) {
        fail(source, `${at} lists runner '${runner}', which is already in tier '${other}'`);
      }
      placed.set(runner, name);
      if (!members.includes(runner)) members.push(runner);
    }
    if (effort !== undefined) {
      if (typeof effort !== "string" || !EFFORT_NAME.test(effort)) {
        fail(source, `${at}.effort must be an effort level (letters, digits, '_', '-')`);
      }
      for (const runner of members) {
        const allowed = runners[runner]?.efforts ?? [];
        if (!allowed.includes(effort)) {
          fail(
            source,
            `${at}.effort '${effort}' is not on worker.runners.${runner}.efforts (${allowed.join(", ") || "none"})`,
          );
        }
      }
    }
    tiers.push({
      name,
      runners: members,
      ...(effort === undefined ? {} : { effort: effort as string }),
    });
  }
  return tiers;
}

function parseEscalation(
  value: unknown,
  tiers: readonly WorkerTier[],
  source: string,
): WorkerEscalationPolicy {
  if (value === undefined) return { ...DEFAULT_WORKER_POLICY.escalation };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "worker.escalation must be a mapping with maxSteps");
  }
  const escalation = value as Record<string, unknown>;
  for (const key of Object.keys(escalation)) {
    if (!(ESCALATION_KEYS as readonly string[]).includes(key)) {
      fail(
        source,
        `unknown key 'worker.escalation.${key}'; known keys: ${ESCALATION_KEYS.join(", ")}`,
      );
    }
  }
  const maxSteps = boundedInt(
    escalation["maxSteps"],
    DEFAULT_WORKER_POLICY.escalation.maxSteps,
    0,
    MAX_TIERS - 1,
    "escalation.maxSteps",
    source,
  );
  // Climbing needs somewhere to climb to; a limit with no ladder is a typo.
  if (maxSteps > 0 && tiers.length < 2) {
    fail(source, "worker.escalation.maxSteps needs at least two worker.tiers to climb");
  }
  return { maxSteps };
}

function parseRetryPolicy(value: unknown, source: string): WorkerRetryPolicy {
  if (value === undefined) return { ...DEFAULT_WORKER_POLICY.retry };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "worker.retry must be a mapping with onFailure and backoffMinutes");
  }
  const retry = value as Record<string, unknown>;
  for (const key of Object.keys(retry)) {
    if (!(RETRY_KEYS as readonly string[]).includes(key)) {
      fail(source, `unknown key 'worker.retry.${key}'; known keys: ${RETRY_KEYS.join(", ")}`);
    }
  }
  const onFailure = retry["onFailure"];
  if (
    onFailure !== undefined &&
    (typeof onFailure !== "string" || !(RETRY_ACTIONS as readonly string[]).includes(onFailure))
  ) {
    fail(
      source,
      `worker.retry.onFailure must be one of: ${RETRY_ACTIONS.join(", ")} (got ${JSON.stringify(onFailure)})`,
    );
  }
  return {
    ...(onFailure === undefined ? {} : { onFailure: onFailure as RetryAction }),
    backoffMinutes: boundedInt(
      retry["backoffMinutes"],
      DEFAULT_WORKER_POLICY.retry.backoffMinutes,
      0,
      1440,
      "retry.backoffMinutes",
      source,
    ),
  };
}

function isArgv(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string" && part.length > 0)
  );
}

/** One runner, in either the short argv form or the mapping form. */
function parseRunner(name: string, entry: unknown, source: string): WorkerRunner {
  if (Array.isArray(entry)) {
    if (!isArgv(entry)) {
      fail(source, `worker.runners.${name} must be a non-empty list of strings (argv, no shell)`);
    }
    return { argv: [...entry], worktree: false };
  }
  if (entry === null || typeof entry !== "object") {
    fail(
      source,
      `worker.runners.${name} must be a non-empty list of strings (argv, no shell) or a mapping with argv`,
    );
  }
  const runner = entry as Record<string, unknown>;
  for (const key of Object.keys(runner)) {
    if (!(RUNNER_KEYS as readonly string[]).includes(key)) {
      fail(
        source,
        `unknown key 'worker.runners.${name}.${key}'; known keys: ${RUNNER_KEYS.join(", ")}`,
      );
    }
  }
  const argv = runner["argv"];
  if (!isArgv(argv)) {
    fail(
      source,
      `worker.runners.${name}.argv must be a non-empty list of strings (argv, no shell)`,
    );
  }
  const model = runner["model"];
  if (
    model !== undefined &&
    (typeof model !== "string" || model.trim() !== model || !MODEL_NAME.test(model))
  ) {
    fail(
      source,
      `worker.runners.${name}.model must be a model name (letters, digits, '.', '_', ':', /, -; no spaces)`,
    );
  }
  const effort = runner["effort"];
  if (
    effort !== undefined &&
    (typeof effort !== "string" || effort.trim() !== effort || !EFFORT_NAME.test(effort))
  ) {
    fail(
      source,
      `worker.runners.${name}.effort must be an effort level (letters, digits, '_', '-'; no spaces, no leading '-')`,
    );
  }
  // Only claude has an effort flag oguri knows. Refusing the key elsewhere
  // beats accepting it and then adding nothing, which would leave a person
  // believing the level is in force.
  if (effort !== undefined && runnerFlavor(argv) !== "claude") {
    fail(
      source,
      `worker.runners.${name}.effort needs a claude argv (--effort); this runner's command has no effort flag oguri knows`,
    );
  }
  const efforts = runner["efforts"];
  if (efforts !== undefined && !Array.isArray(efforts)) {
    fail(source, `worker.runners.${name}.efforts must be a list of effort levels`);
  }
  const effortAllowList: string[] = [];
  for (const level of (efforts ?? []) as unknown[]) {
    if (typeof level !== "string" || !EFFORT_NAME.test(level)) {
      fail(
        source,
        `worker.runners.${name}.efforts contains an invalid level ${JSON.stringify(level)}; use letters, digits, '_', '-'`,
      );
    }
    if (!effortAllowList.includes(level)) effortAllowList.push(level);
  }
  if (effortAllowList.length > 0 && effort === undefined && runnerFlavor(argv) !== "claude") {
    fail(
      source,
      `worker.runners.${name}.efforts needs a claude argv (--effort); a task can only pick a level this command understands`,
    );
  }
  const workdir = runner["workdir"];
  if (workdir !== undefined && (typeof workdir !== "string" || workdir.length === 0)) {
    fail(source, `worker.runners.${name}.workdir must be a path`);
  }
  const worktree = runner["worktree"] ?? false;
  if (typeof worktree !== "boolean") {
    fail(source, `worker.runners.${name}.worktree must be true or false`);
  }
  const session = runner["session"];
  if (
    session !== undefined &&
    (typeof session !== "string" || !(SESSION_MODES as readonly string[]).includes(session))
  ) {
    fail(
      source,
      `worker.runners.${name}.session must be one of: ${SESSION_MODES.join(", ")} (got ${JSON.stringify(session)})`,
    );
  }
  const oguriTools = runner["oguriTools"];
  if (oguriTools !== undefined && typeof oguriTools !== "boolean") {
    fail(source, `worker.runners.${name}.oguriTools must be true or false`);
  }
  const requireResult = runner["requireResult"];
  if (requireResult !== undefined && typeof requireResult !== "boolean") {
    fail(source, `worker.runners.${name}.requireResult must be true or false`);
  }
  const resume = runner["resume"];
  if (resume !== undefined) {
    if (!isArgv(resume)) {
      fail(
        source,
        `worker.runners.${name}.resume must be a non-empty list of strings (argv, no shell)`,
      );
    }
    // Exactly once: zero would resume nothing, two would put the id where a
    // person did not mean it to go.
    const tokens = resume.join("\u0000").split(SESSION_TOKEN).length - 1;
    if (tokens !== 1) {
      fail(
        source,
        `worker.runners.${name}.resume must contain ${SESSION_TOKEN} exactly once (found ${String(tokens)})`,
      );
    }
    // Without a session source there is never an id to put in it.
    if (session === undefined) {
      fail(
        source,
        `worker.runners.${name}.resume needs session: ${SESSION_MODES.join(" | ")}, so the worker knows where the id comes from`,
      );
    }
  }
  return {
    argv: [...argv],
    ...(model === undefined ? {} : { model: model as string }),
    ...(effort === undefined ? {} : { effort: effort as string }),
    ...(effortAllowList.length === 0 ? {} : { efforts: effortAllowList }),
    ...(workdir === undefined ? {} : { workdir: workdir as string }),
    worktree,
    ...(resume === undefined ? {} : { resume: [...(resume as string[])] }),
    ...(session === undefined ? {} : { session: session as SessionMode }),
    ...(oguriTools === undefined ? {} : { oguriTools: oguriTools as boolean }),
    ...(requireResult === undefined ? {} : { requireResult: requireResult as boolean }),
  };
}

/**
 * Where policy is read from, nearest last.
 *
 * A per-agent home is `<machine-root>/agents/<id>`, and an agent running there
 * has that home as its whole world. Without the machine-root lookup a person
 * who set a policy once would find it silently ignored by every agent they
 * provisioned, which is exactly the failure this file is meant to prevent.
 */
export function policySearchPath(layout: Layout): string[] {
  const home = join(layout.root, "policy.yaml");
  const parent = dirname(layout.root);
  const isAgentHome = basename(parent) === "agents" && isAgentId(basename(layout.root));
  if (!isAgentHome) return [home];
  return [join(dirname(parent), "policy.yaml"), home];
}

/** Load and merge the policy files that apply to this home. */
export async function loadLocalPolicy(layout: Layout): Promise<ResolvedPolicy> {
  const policy: LocalPolicy = {
    v: DEFAULT_LOCAL_POLICY.v,
    approvals: { ...DEFAULT_LOCAL_POLICY.approvals },
    worker: defaultWorkerPolicy(),
    // --- notifications (ADR 0028) ---
    notifications: { channels: [] },
    // --- end notifications ---
    // --- intake (ADR 0030) ---
    intake: { ...DEFAULT_INTAKE_POLICY },
    // --- end intake ---
    // --- superagent (ADR 0031) ---
    superagent: structuredClone(DEFAULT_SUPERAGENT_POLICY),
    // --- end superagent ---
  };
  const sources: string[] = [];

  for (const path of policySearchPath(layout)) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = parseLocalPolicy(raw, path);
    sources.push(path);
    if (parsed.approvals?.inboundWork !== undefined) {
      policy.approvals.inboundWork = parsed.approvals.inboundWork;
    }
    if (parsed.approvals?.localAgents !== undefined) {
      policy.approvals.localAgents = parsed.approvals.localAgents;
    }
    // The nearest file that mentions `worker` decides it whole. Merging key by
    // key would let a machine-wide runner list leak into an agent home that
    // set its own, which is the opposite of what writing the section means.
    if (parsed.worker !== undefined) policy.worker = parsed.worker;
    // --- notifications (ADR 0028) ---
    // Whole-section override, like `worker`: an agent home that lists its own
    // channels does not also push to the machine-wide ones.
    if (parsed.notifications !== undefined) policy.notifications = parsed.notifications;
    // --- end notifications ---
    // --- intake (ADR 0030) ---
    // Whole-section override, like `worker`.
    if (parsed.intake !== undefined) policy.intake = parsed.intake;
    // --- end intake ---
    // --- superagent (ADR 0031) ---
    if (parsed.superagent !== undefined) policy.superagent = parsed.superagent;
    // --- end superagent ---
  }

  return { policy, sources };
}

/**
 * Decide where a delegation came from, using only what this machine knows.
 *
 * `self` is local because creating your own task is not a delegation. Every
 * other agent is remote until a person lists it, for the reason stated on
 * `localAgents`.
 */
export function originOf(creator: string, self: string, policy: ApprovalPolicy): WorkOrigin {
  if (creator === self) return "local";
  return policy.localAgents.includes(creator) ? "local" : "remote";
}

/** Whether taking on this delegation needs a person first. */
export function approvalRequired(origin: WorkOrigin, policy: ApprovalPolicy): boolean {
  if (policy.inboundWork === "never") return false;
  if (policy.inboundWork === "always") return true;
  return origin === "remote";
}

/**
 * How many runs this machine may run at once, as the worker engine really
 * applies it.
 *
 * A small superagent replaces `worker.concurrency` with its own `maxWorkers`
 * while it is on, because it is the role that decides how many workers a
 * request needs. That substitution lives here rather than in the CLI surface
 * that builds the worker's policy, so `oguri worker status`,
 * `oguri superagent status`, and the engine can never disagree about the
 * number: each asks this one function.
 */
export function effectiveConcurrency(policy: Pick<LocalPolicy, "worker" | "superagent">): number {
  const small = policy.superagent.small;
  if (!small.enabled) return policy.worker.concurrency;
  return Math.min(small.maxWorkers, MAX_RUN_CONCURRENCY);
}

/** A commented starting point, written only by `oguri policy --init`. */
export function policyTemplate(): string {
  return `# oguri — machine-local policy
#
# oguri reads this file and never rewrites it, so comments and ordering
# survive. It is local to this machine: it constrains YOUR agent and is not
# visible to, or settable by, anyone else on the network.
#
# Not to be confused with:
#   .oguri/policy.yaml INSIDE the transport repo — network-wide, shared
#   rooms/<id>/room.yaml                          — per-room, shared
v: 1

approvals:
  # Must a person approve before this agent takes on work someone delegated?
  #
  #   never   take any work without asking — fully autonomous
  #   remote  ask only for work delegated from another machine  (default)
  #   always  ask for everything, including work you created yourself
  #
  # Applies to claiming a task and claiming a delegated repository review.
  # Answering questions, sending messages, and reporting progress are never
  # gated: the gate is about committing to do work, not about talking.
  inboundWork: remote

  # Agents whose delegations count as local, so they are not gated under
  # 'remote'. This agent is always local and does not need listing.
  #
  # Listed HERE rather than detected, on purpose: an agent card is written by
  # the machine it describes, so a peer could otherwise declare itself local
  # and walk straight through the gate.
  localAgents: []

worker:
  # May 'oguri worker' claim tasks addressed to this agent or this machine,
  # run them, and report the result? (ADR 0026)
  #
  # It only ever runs the argv listed under 'runners', with NO shell. A task can
  # pick a runner by name with a first line such as 'runner: codex', and an
  # effort from that runner's 'efforts' list with 'effort: high', but it cannot
  # add an argument. The task text is passed on stdin, never on the command line.
  enabled: false
  concurrency: 1        # runs at once, 1 to 20
  maxPerHour: 6
  timeoutMinutes: 180   # one run's limit, 1 to 1440; an older config that sets it keeps its value
  # workdir: ~/work
  runners: {}
  #   claude: ["claude", "-p", "--output-format", "text"]
  #   codex: ["codex", "exec", "-"]
  #   # The mapping form gives a runner its own directory and can name a model
  #   # or an effort. claude gets --model <m> or --effort <level>; codex gets
  #   # -m <m>. An argv that already has its own flag keeps it. 'efforts' is
  #   # the list a task may pick from with an 'effort: <level>' line; a level
  #   # outside it is ignored, and the runner's own effort applies.
  #   fixer:
  #     argv: ["claude", "-p"]
  #     model: sonnet
  #     effort: medium
  #     efforts: [low, medium, high]
  #     workdir: ~/src/app
  #     worktree: true
  #   # A runner that keeps one agent session per task (ADR 0030). session
  #   # says where the id comes from: claude-json, codex-jsonl, or file
  #   # ($OGURI_SESSION_FILE). resume continues it; {session} appears once.
  #   chat:
  #     argv: ["claude", "-p", "--output-format", "json"]
  #     resume: ["claude", "-p", "--output-format", "json", "--resume", "{session}"]
  #     session: claude-json
  #   # requireResult: true makes a run that exits 0 without writing result.json
  #   # a retry or a block instead of a completion. Leave it out for a runner
  #   # with no result protocol; its report then says no file was written.
  #   # A live session (ADR 0032): a person's message reaches the run while it
  #   # works, in the same process. claude and codex runs get oguri's tools
  #   # (progress, ask, handback) unless the runner sets oguriTools: false.
  #   live:
  #     argv: ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
  #     resume: ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", "{session}"]
  #     session: claude-stream
  #     # oguriTools: false
  # defaultRunner: claude
  # plannerRunner: claude   # runner 'oguri plan' uses; defaults to defaultRunner
  #
  # A run cut off by a crash or a forced stop is found on the next start.
  # release: hand its task back so another machine may take it  (default)
  # block:   keep it here, blocked, for a person to look at
  onAbandon: release
  #
  # A failed run (non-zero exit, timeout, crash) with attempts left under the
  # task's maxAttempts is released, so any eligible machine may try again; this
  # one waits backoffMinutes before it takes the task back. Without maxAttempts
  # the task is blocked. onFailure: release or block overrides that choice.
  # A task whose attempts are used up is always blocked for a person.
  retry:
    backoffMinutes: 10
  #   onFailure: release
  #
  # Task capabilities this worker asserts (ADR 0027), e.g. [gpu, macos].
  # Free tasks that require only these are claimed too, and the names are
  # added to this agent's profile once so planners can see them.
  capabilities: []
  #
  # Agents whose REMOTE tasks the worker may approve by itself. Everyone else
  # still waits for 'oguri task approve'. Each auto-approval is recorded.
  trustedRequesters: []
  #
  # A person's later message in a task's thread runs that task again, in the
  # same directory and agent session (ADR 0030). This many days after this
  # worker completed a task, it stops doing that; 0 turns it off for
  # completed tasks.
  followupDays: 14
  #
  # Runner tiers, cheapest first (ADR 0034). The superagents pick one per
  # worker by difficulty and write 'tier: <name>' on its task; a tier names
  # only entries of 'runners' above, and its effort must be on their 'efforts'.
  # tiers:
  #   cheap: [fixer]
  #   standard:
  #     runners: [chat]
  #     effort: medium
  # A failed run of a tiered task moves it this many tiers up, at most, over
  # its life. 0 (the default) never moves it.
  # escalation:
  #   maxSteps: 1
  #
  # How many parents a subtask created inside a run may have, 0 to 8 (ADR 0036).
  # A run past it is told to hand the work back; 0 means runs create no subtasks.
  maxTaskDepth: 2

# --- notifications (ADR 0028) ---
notifications:
  # Push channels for a phone or a team chat, sent by the daemon. Each
  # channel picks its events: needs-human, task-completed and task-blocked
  # (tasks this agent created), mentions, all. The default is the first three.
  # Bodies are secret-scanned and trimmed; 30 pushes per channel per hour.
  # Test one with: oguri notify test --channel <name>
  channels: {}
  #   phone:
  #     format: telegram
  #     token: "123456:ABC..."
  #     chatId: "42"
  #   team:
  #     format: wecom        # or feishu, or json for any webhook
  #     url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
  #     events: [needs-human, task-blocked]
  #   me:                    # a direct message to one person on Feishu
  #     format: feishu-app   # a self-built app with the bot ability and
  #     appId: cli_...       # the im:message:send_as_bot permission
  #     appSecret: "..."
  #     receiveId: you@example.com   # email, or set receiveIdType: open_id
  #     # apiUrl: https://open.larksuite.com   # for Lark outside China

# --- superagent (ADR 0031) ---
# superagent:
#   # The big superagent: the one agent you talk to ('oguri big "..."'). It
#   # decides which workers to deploy on which machine, passes your messages
#   # to them, moves or stops them, and tells you when they finish. Run it on
#   # one machine: 'oguri superagent start'.
#   big:
#     enabled: true
#     # room: superagent        # where you talk to the superagents
#     # workRoom: superagent-work  # where workers' tasks go (default: <room>-work)
#     # runner: claude          # an entry of worker.runners it thinks with
#     # timeoutSeconds: 180
#     # coordinate: true        # act on the small superagents' reports
#   # The small superagent: on every machine with a worker. It runs this
#   # machine's workers (one agent session per task), reports on them, and
#   # answers when you talk to it ('oguri small <machine> "..."').
#   small:
#     enabled: true
#     # big: alice-big         # the big superagent's agent id; its workers need no approval here
#     # talk: true
#     # maxWorkers: 3         # how many workers it may run here at once (1 to 20)
#     # quietMinutes: 30
#     # reportEveryMinutes: 60
#
# --- intake (ADR 0030) ---
# intake:
#   # Turn requests in a Feishu chat into tasks: 'oguri intake start'. A message
#   # is a request when it mentions the app's bot and its sender's open_id is
#   # listed under 'allowed' (or the chat sets anyone: true). Code decides this;
#   # no model is asked. The app needs the bot ability and permission to read
#   # and send group messages. The secret stays in this file.
#   enabled: true
#   feishu:
#     appId: cli_...
#     appSecret: "..."
#     # apiUrl: https://open.larksuite.com   # for Lark outside China
#     allowed: [ou_0123456789abcdef]   # open_ids of people who may start work
#     chats:
#       oc_0123456789abcdef:         # the chat id
#         room: app              # the room its tasks are created in
#         target: machine:build-box   # who runs them; omit for any eligible worker
#   # githubCli: gh              # follows the pull requests results name
#   # maxReplyWords: 100
`;
}
