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
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { runsDir } from "./runs.ts";

/** Only the end of a large log is read: a codex or streaming session can grow to megabytes. */
const TAIL_LIMIT = 1024 * 1024;

export interface TodayUsage {
  /** Local calendar day the figures cover, as `YYYY-MM-DD`. */
  date: string;
  /** Runs that started today, including ones still in flight. */
  runs: number;
  /** Summed `total_cost_usd`, or null when no run reported one. */
  costUsd: number | null;
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

/**
 * The last `total_cost_usd` a log carries.
 *
 * Claude may print a plain notice before its JSON, and streaming sessions put
 * the total on the final `result` event, so every line is tried from the end.
 * The whole text is tried first because a formatted (multi-line) object would
 * not parse as one line.
 */
export function parseTotalCost(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const cost = costOf(JSON.parse(trimmed));
    if (cost !== null) return cost;
  } catch {
    // Not one JSON document; scan line by line.
  }
  const lines = trimmed.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      for (let item = parsed.length - 1; item >= 0; item -= 1) {
        const cost = costOf(parsed[item]);
        if (cost !== null) return cost;
      }
      continue;
    }
    const cost = costOf(parsed);
    if (cost !== null) return cost;
  }
  return null;
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

interface RunStart {
  startedAt?: Date;
  stdoutPath: string;
}

async function startOfRecord(path: string): Promise<Date | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { startedAt?: unknown };
    if (typeof parsed.startedAt !== "string") return undefined;
    const date = new Date(parsed.startedAt);
    return Number.isNaN(date.getTime()) ? undefined : date;
  } catch {
    return undefined;
  }
}

/**
 * Runs under one task directory, in both layouts: `runs/<task>/<run>/` and the
 * older `runs/<task>/` whose record and log sit side by side.
 */
async function runsOfTask(taskDir: string): Promise<RunStart[]> {
  let names: string[];
  try {
    names = await readdir(taskDir);
  } catch {
    return [];
  }
  const runs: RunStart[] = [];
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
    if (!(await isFile(recordPath)) && !(await isFile(join(path, "stdout.log")))) continue;
    const startedAt = await startOfRecord(recordPath);
    runs.push({
      ...(startedAt === undefined ? {} : { startedAt }),
      stdoutPath: join(path, "stdout.log"),
    });
  }
  // The older layout keeps the record directly in the task directory.
  if (await isFile(join(taskDir, "run.json"))) {
    const startedAt = await startOfRecord(join(taskDir, "run.json"));
    runs.push({
      ...(startedAt === undefined ? {} : { startedAt }),
      stdoutPath: join(taskDir, "stdout.log"),
    });
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

/**
 * Every run that started on the local day containing `now`, and what those
 * runs cost. A run with no readable record is dated by its log's mtime.
 */
export async function todayUsage(home: string, now: number = Date.now()): Promise<TodayUsage> {
  const day = localDate(new Date(now));
  let runs = 0;
  let costUsd: number | null = null;
  let taskDirs: string[] = [];
  try {
    taskDirs = await readdir(runsDir(home));
  } catch {
    return { date: day, runs: 0, costUsd: null };
  }
  for (const task of taskDirs) {
    for (const run of await runsOfTask(join(runsDir(home), task))) {
      const startedAt = run.startedAt ?? (await mtime(run.stdoutPath));
      if (startedAt === undefined || localDate(startedAt) !== day) continue;
      runs += 1;
      const cost = parseTotalCost(await readTail(run.stdoutPath));
      if (cost !== null) costUsd = (costUsd ?? 0) + cost;
    }
  }
  return { date: day, runs, costUsd };
}
