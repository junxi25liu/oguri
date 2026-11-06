/**
 * What this machine's workers cost today, read from their own logs.
 *
 * Every run keeps its full output under `<home>/runs/<task>/<run>/stdout.log`;
 * only a summary is published. The runner already tells us the price of a run
 * (`claude` prints `total_cost_usd` in its JSON result), so the local logs
 * answer "how many runs, and how much" without sending anything anywhere.
 *
 * A log that cannot be read, or that carries no price, contributes no cost.
 * Codex and a plain `claude -p` print no price at all, so the caller shows the
 * run count without a figure rather than inventing a zero.
 *
 * The price is **cumulative for a session**, not for a run. `claude` resumes a
 * session and prints everything that session has spent so far, so adding each
 * run's figure counts the earlier money again every time a session is resumed.
 * The figure is therefore computed per session: the latest cumulative value a
 * session reported today, minus the latest value it had reported before today,
 * which is what today actually spent.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { runsDir } from "./runs.ts";
import { validSessionId } from "./session.ts";

/** Only the end of a large log is read: a codex or streaming session can grow to megabytes. */
const TAIL_LIMIT = 1024 * 1024;

export interface TodayUsage {
  /** Local calendar day the figures cover, as `YYYY-MM-DD`. */
  date: string;
  /** Runs that started today, including ones still in flight. */
  runs: number;
  /**
   * The **known subtotal**: what today's priced runs spent, each session
   * counted once, by the increment on top of what it had already spent.
   *
   * This is not the whole day. `unpricedRuns` says how many of today's runs it
   * does not cover, so no caller can present it as a total. Null when no run
   * reported a price at all.
   */
  costUsd: number | null;
  /**
   * Today's runs the subtotal does not cover: no price was reported, or the
   * only run that would have reported one is still in flight.
   */
  unpricedRuns: number;
}

/** `YYYY-MM-DD` in local time, which is how a person reads "today". */
export function localDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function costOf(value: unknown): number | null {
  const object = record(value);
  const cost = object?.["total_cost_usd"];
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** What one run's own output says about the run, beyond its text. */
export interface RunOutput {
  /** The session the run belongs to, when its output names one. */
  sessionId?: string;
  /** The cumulative price of that session at the end of this run. */
  costUsd?: number;
}

/**
 * The session and cumulative price a log carries.
 *
 * Claude may print a plain notice before its JSON, and streaming sessions put
 * the id on every event and the total on the final `result` event, so the
 * whole text is tried first (a formatted object is not one line) and every
 * JSON line is then read in order, the last value winning.
 */
export function parseRunOutput(text: string): RunOutput {
  const found: RunOutput = {};
  const take = (value: unknown): void => {
    const object = record(value);
    if (object === null) return;
    const id = object["session_id"];
    if (validSessionId(id)) found.sessionId = id;
    const cost = costOf(object);
    if (cost !== null) found.costUsd = cost;
  };
  const takeAll = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) take(item);
      return;
    }
    take(value);
  };
  const trimmed = text.trim();
  if (trimmed === "") return found;
  try {
    takeAll(JSON.parse(trimmed));
    return found;
  } catch {
    // Not one JSON document; scan line by line.
  }
  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      takeAll(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return found;
}

/** The last `total_cost_usd` a log carries, or null when it carries none. */
export function parseTotalCost(text: string): number | null {
  return parseRunOutput(text).costUsd ?? null;
}

/** Read the whole file when small, or its end when large. "" when it cannot be read. */
async function readTail(path: string): Promise<string> {
  let size = 0;
  try {
    const info = await stat(path);
    if (!info.isFile()) return "";
    size = info.size;
  } catch {
    return "";
  }
  const start = Math.max(0, size - TAIL_LIMIT);
  try {
    if (start === 0) return await readFile(path, "utf8");
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, size - start, start);
      // Drop the partial first line; the parser works on whole lines anyway.
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return text.slice(text.indexOf("\n") + 1);
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/**
 * What this run cost, as its own log reports it, or null when it reports none.
 *
 * Recorded into `run.json` by the worker so a run carries its price even after
 * its log is pruned. It is the session's cumulative figure at the end of the
 * run, which `todayUsage` takes into account.
 */
export async function readRunCost(runDir: string): Promise<number | null> {
  return parseTotalCost(await readTail(join(runDir, "stdout.log")));
}

interface RunFacts {
  /** Where the record is; also the identity of a run with no session. */
  recordPath: string;
  stdoutPath: string;
  startedAt?: Date;
  /** From the record: absent on older records, or when the run never reported one. */
  sessionId?: string;
  /** From the record, when this version of the worker wrote it. */
  costUsd?: number;
  /** The run has not finished, so its reported price is not final. */
  running: boolean;
}

async function factsOfRecord(path: string, stdoutPath: string): Promise<RunFacts> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      startedAt?: unknown;
      sessionId?: unknown;
      costUsd?: unknown;
      outcome?: unknown;
    };
    const startedAt =
      typeof parsed.startedAt === "string" && !Number.isNaN(new Date(parsed.startedAt).getTime())
        ? new Date(parsed.startedAt)
        : undefined;
    return {
      recordPath: path,
      stdoutPath,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(validSessionId(parsed.sessionId) ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.costUsd === "number" &&
      Number.isFinite(parsed.costUsd) &&
      parsed.costUsd >= 0
        ? { costUsd: parsed.costUsd }
        : {}),
      running: parsed.outcome === "running",
    };
  } catch {
    // An unreadable record is dated by its log, and has no session of its own.
    return { recordPath: path, stdoutPath, running: false };
  }
}

/**
 * Runs under one task directory, in both layouts: `runs/<task>/<run>/` and the
 * older `runs/<task>/` whose record and log sit side by side.
 */
async function runsOfTask(taskDir: string): Promise<RunFacts[]> {
  let names: string[];
  try {
    names = await readdir(taskDir);
  } catch {
    return [];
  }
  const runs: RunFacts[] = [];
  for (const name of names) {
    const path = join(taskDir, name);
    let isDirectory = false;
    try {
      isDirectory = (await stat(path)).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    const recordPath = join(path, "run.json");
    const stdoutPath = join(path, "stdout.log");
    if (!(await isFile(recordPath)) && !(await isFile(stdoutPath))) continue;
    runs.push(await factsOfRecord(recordPath, stdoutPath));
  }
  // The older layout keeps the record directly in the task directory.
  const recordPath = join(taskDir, "run.json");
  if (await isFile(recordPath)) {
    runs.push(await factsOfRecord(recordPath, join(taskDir, "stdout.log")));
  }
  return runs;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function mtime(path: string): Promise<Date | undefined> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return undefined;
  }
}

/** A run's session and price, from its record and, where that is not enough, its log. */
async function resolve(run: RunFacts): Promise<{ sessionId?: string; costUsd?: number }> {
  const known = {
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
  };
  // A record from this version carries both, and its log may long since be gone.
  if (known.sessionId !== undefined && known.costUsd !== undefined) return known;
  const parsed = parseRunOutput(await readTail(run.stdoutPath));
  return {
    ...(known.sessionId === undefined
      ? parsed.sessionId === undefined
        ? {}
        : { sessionId: parsed.sessionId }
      : { sessionId: known.sessionId }),
    ...(known.costUsd === undefined
      ? parsed.costUsd === undefined
        ? {}
        : { costUsd: parsed.costUsd }
      : { costUsd: known.costUsd }),
  };
}

/** The session a run belongs to, or a key of its own when no session is known. */
function sessionKey(run: RunFacts, sessionId: string | undefined): string {
  return sessionId === undefined ? `run:${run.recordPath}` : `session:${sessionId}`;
}

/**
 * Every run that started on the local day containing `now`, and what those
 * runs spent. A run with no readable record is dated by its log's mtime.
 */
export async function todayUsage(home: string, now: number = Date.now()): Promise<TodayUsage> {
  const day = localDate(new Date(now));
  let taskDirs: string[] = [];
  try {
    taskDirs = await readdir(runsDir(home));
  } catch {
    return { date: day, runs: 0, costUsd: null, unpricedRuns: 0 };
  }
  const all: RunFacts[] = [];
  for (const task of taskDirs) {
    all.push(...(await runsOfTask(join(runsDir(home), task))));
  }
  for (const run of all) {
    if (run.startedAt !== undefined) continue;
    const touched = await mtime(run.stdoutPath);
    if (touched !== undefined) run.startedAt = touched;
  }

  const today = all.filter(
    (run) => run.startedAt !== undefined && localDate(run.startedAt) === day,
  );
  if (today.length === 0) return { date: day, runs: 0, costUsd: null, unpricedRuns: 0 };

  // A session is one bill, however many runs it took.
  const groups = new Map<string, RunFacts[]>();
  const resolved = new Map<RunFacts, { sessionId?: string; costUsd?: number }>();
  const keyOf = new Map<RunFacts, string>();
  for (const run of today) {
    const facts = await resolve(run);
    resolved.set(run, facts);
    const key = sessionKey(run, facts.sessionId);
    keyOf.set(run, key);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  /** The newest finished run of a list that reported a price, or undefined. */
  const latestPriced = async (
    runs: readonly RunFacts[],
  ): Promise<{ startedAt: number; costUsd: number } | undefined> => {
    let best: { startedAt: number; costUsd: number } | undefined;
    for (const run of runs) {
      if (run.running) continue;
      const facts = resolved.get(run) ?? (await resolve(run));
      resolved.set(run, facts);
      if (facts.costUsd === undefined) continue;
      const startedAt = run.startedAt?.getTime() ?? 0;
      if (best === undefined || startedAt >= best.startedAt) {
        best = { startedAt, costUsd: facts.costUsd };
      }
    }
    return best;
  };

  let costUsd: number | null = null;
  /** Sessions whose figure this subtotal includes. */
  const priced = new Set<string>();
  for (const [key, runs] of groups) {
    const spentToday = await latestPriced(runs);
    if (spentToday === undefined) continue;
    priced.add(key);
    // The figure is cumulative, so what the session had already spent is not
    // today's: subtract the last value it reported on an earlier day. A run
    // without a session is its own bill, and has nothing before today.
    let spentBefore = 0;
    if (key.startsWith("session:")) {
      const sessionId = key.slice("session:".length);
      const earlier: RunFacts[] = [];
      for (const run of all) {
        if (run.startedAt === undefined || localDate(run.startedAt) === day) continue;
        const facts = resolved.get(run) ?? (await resolve(run));
        resolved.set(run, facts);
        if (facts.sessionId === sessionId) earlier.push(run);
      }
      spentBefore = (await latestPriced(earlier))?.costUsd ?? 0;
    }
    costUsd = (costUsd ?? 0) + Math.max(0, spentToday.costUsd - spentBefore);
  }
  // A run is outside the subtotal when nothing that finished can vouch for it:
  // either its session reported no final price, or the run has not finished
  // and so its own spend is not in the figure yet. A finished run of a priced
  // session is covered by that session's cumulative total, however many turns
  // it took.
  const unpricedRuns = today.filter((run) => {
    if (run.running) return true;
    const key = keyOf.get(run);
    return key === undefined || !priced.has(key);
  }).length;
  return { date: day, runs: today.length, costUsd, unpricedRuns };
}
