/**
 * The local record of every run, under `<home>/runs/<task-id>/<run-id>/`.
 *
 * Full output stays here and never enters the shared log; only a summary is
 * published. `run.json` is what `oguri worker runs` reads, what a restarted
 * worker reconciles, and what seeds the hourly budget.
 *
 * Each run gets its own directory, so a task that is reopened and run again
 * keeps the logs of its earlier runs. Records written before that layout sit
 * directly at `runs/<task-id>/run.json` and are still read.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ulid } from "@oguri/protocol";

export type RunOutcome =
  | "running"
  | "completed"
  | "blocked"
  /** The run failed and the task was handed back for another try. */
  | "released"
  /** The run succeeded and the task waits for the subtasks it created. */
  | "waiting"
  | "unreported"
  /** The worker stopped or died while the run was in flight. */
  | "abandoned"
  /** The task was cancelled or reassigned during the run, so the run was stopped. */
  | "cancelled"
  /** A follow-up on a task that stays completed was answered in its thread. */
  | "answered"
  /** A follow-up on a task that stays completed failed; nothing was published to the task. */
  | "failed";

/**
 * A run's result that could not be published, held until it can be.
 *
 * Lives only in `run.json`, for as long as the record is `unreported`; the
 * worker retries it on every pass and every start, and removes it once the
 * task has heard it or no longer wants it.
 */
export interface PendingReport {
  /** The task transition to publish, or `note` for an answer posted in the task's thread. */
  action: "completed" | "blocked" | "released" | "progressed" | "note";
  body: string;
  refs: string[];
  needsHuman: boolean;
  /** Publications that failed so far, the first one included. */
  attempts: number;
  /** Not retried before this moment (ISO time). */
  nextAt: string;
  lastError?: string;
  /** The short, output-free report tried once the full one has failed repeatedly. */
  fallbackBody?: string;
  /** `note` only: where the answer goes, and the outcome the run settles as. */
  post?: { thread: string; inReplyTo: string; settleAs: "answered" | "failed" };
  /** What the chat is told once the report is out, when the task came from a chat. */
  relay?: {
    room: string;
    thread: string;
    inReplyTo: string;
    action: "completed" | "blocked" | "released" | "progressed";
    summary?: string;
    pr?: string;
    question?: string;
    failure?: string;
  };
}

export interface RunRecord {
  taskId: string;
  /** Absent only on records written before per-run directories existed. */
  runId?: string;
  room: string;
  title: string;
  runner: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  /** Processes the executor left running that the runner stopped when the run ended; absent when none. */
  reapedBackground?: number;
  outcome: RunOutcome;
  /** Why the outcome could not be reported, when it could not. */
  note?: string;
  /** The report still to publish while the outcome is `unreported`. Absent on records older than R2. */
  pendingReport?: PendingReport;
  /** The executor process, which leads its own process group. */
  pid?: number;
  /** When the executor started; bounds the start time of the process `pid` names. */
  spawnedAt?: string;
  /** The worker that supervised the run. A restart uses it to tell a live run from a dead one. */
  workerPid?: number;
  /** Directory the executor ran in. */
  cwd?: string;
  /** The git worktree the run used, when its runner asks for one. */
  worktree?: { path: string; branch: string };
  /** When a restarted worker settled the task of an abandoned run. */
  reconciledAt?: string;
  /** The task's claim count after this run's claim. */
  attempt?: number;
  /** The task's thread, where follow-ups from a person arrive (ADR 0030). */
  thread?: string;
  /** The task's origin source, such as `feishu`, when it was requested from a chat. */
  origin?: string;
  /** The agent session the run reported, so a follow-up can resume it. */
  sessionId?: string;
  /**
   * The model the runner's argv asked for, when it named one.
   *
   * This is the request, not the outcome: a service may answer with another
   * model, and `modelReported` records that separately. Keeping the two apart
   * means the record never presents an intention as an observation.
   */
  modelRequested?: string;
  /**
   * The model the service's own output named, when it named one.
   *
   * Absent means the service did not say — not that it used the requested
   * model. A cheap model behind an Anthropic-compatible endpoint reports usage
   * but no model at all.
   */
  modelReported?: string;
  /** Missing on legacy records: their model label has unverified provenance. */
  modelSource?: "assistant-message" | "result-model" | "result-usage" | "cli-event";
  modelInitialized?: string;
  modelsUsage?: string[];
  /**
   * The effort level the runner's argv passed, when it passed one.
   *
   * Evidence of the request only. The services do not echo the level back, so
   * nothing here says what was accepted or honoured.
   */
  effortRequested?: string;
  /** The tier the task asked for when this run started (ADR 0034). */
  tier?: string;
  /** The task's `tier-reason:` line, as its requester wrote it. */
  tierReason?: string;
  /**
   * Where this run's failure moved the task: the tier and runner the next try
   * asks for. A request for the next run, not a record of what it used.
   */
  escalatedTo?: { tier: string; runner: string; step: number };
  /**
   * Who chose the effort in the argv: a person's follow-up with its own
   * `effort:` line, the task's header, the task's tier, or the runner's policy.
   * Like `effortRequested`, a request: nothing here says it was honoured.
   */
  effortSource?: "follow-up" | "task" | "tier" | "policy";
  /**
   * What the run reported it cost, in USD.
   *
   * Cumulative for a session: a resumed turn prints the total spent since the
   * session began, not the price of that turn. `usage.ts` therefore counts a
   * session once, so summing this field over every run would overcount.
   */
  costUsd?: number;
  /** The run answered a person's follow-up rather than starting the task. */
  followup?: boolean;
  /** The run continued an earlier session through the runner's `resume` argv. */
  resumed?: boolean;
  /**
   * Where the follow-up window of this task starts: a person's message after
   * this moment, not yet consumed, is a follow-up. A follow-up run keeps the
   * window of the run before it, so a message that arrived between reading
   * the thread and starting the run is not lost.
   */
  followupSince?: string;
}

export function runsDir(home: string): string {
  return join(home, "runs");
}

/** The directory of one run, or the pre-run-id directory of a task when `runId` is absent. */
export function runDir(home: string, taskId: string, runId?: string): string {
  const task = join(runsDir(home), taskId);
  return runId === undefined ? task : join(task, runId);
}

/** A run id sorts by start time and never collides with an earlier run of the same task. */
export function newRunId(now: number = Date.now()): string {
  return ulid(now);
}

/**
 * Write a record atomically.
 *
 * A worker can be killed at any moment, and a half-written `run.json` would be
 * skipped as unreadable — which is exactly the record a restart needs to see.
 */
let writes = 0;

export async function writeRunRecord(home: string, record: RunRecord): Promise<void> {
  const dir = runDir(home, record.taskId, record.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "run.json");
  // Unique per write: two writes of one record may overlap, and a shared temp
  // file would let one rename the other's half-written content away.
  writes += 1;
  const temp = `${target}.${String(process.pid)}-${String(writes)}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, target);
}

async function readRecord(path: string): Promise<RunRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RunRecord;
    if (typeof parsed.taskId === "string" && typeof parsed.startedAt === "string") return parsed;
  } catch {
    // Unreadable records are skipped, not fatal.
  }
  return null;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Every run of one task, newest first. */
export async function taskRuns(home: string, taskId: string): Promise<RunRecord[]> {
  const records = (await recordsIn(runDir(home, taskId))).filter((r) => r.taskId === taskId);
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return records;
}

/** The records of one task directory, in both layouts. */
async function recordsIn(taskDir: string): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const name of await entries(taskDir)) {
    const record =
      name === "run.json"
        ? await readRecord(join(taskDir, name))
        : await readRecord(join(taskDir, name, "run.json"));
    if (record !== null) records.push(record);
  }
  return records;
}

const CONSUMED_FILE = "consumed.json";
/** A task thread is bounded by its reply budget; this only stops the file growing without end. */
const CONSUMED_LIMIT = 2_000;

/**
 * Ids of a person's follow-up messages this worker already handed to a run.
 *
 * Kept per task, beside its runs, so a restart does not answer the same
 * message twice. Missing or unreadable means none.
 */
export async function readConsumed(home: string, taskId: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDir(home, taskId), CONSUMED_FILE), "utf8"),
    ) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export async function addConsumed(
  home: string,
  taskId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const known = await readConsumed(home, taskId);
  for (const id of ids) known.add(id);
  const dir = runDir(home, taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, CONSUMED_FILE);
  writes += 1;
  const temp = `${target}.${String(process.pid)}-${String(writes)}.tmp`;
  await writeFile(temp, `${JSON.stringify([...known].slice(-CONSUMED_LIMIT))}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, target);
}

/** Recent runs, newest first, from both the per-run and the older per-task layout. */
export async function listRuns(home: string, limit = 20): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const task of await entries(runsDir(home))) {
    records.push(...(await recordsIn(join(runsDir(home), task))));
  }
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return records.slice(0, Math.max(0, limit));
}
