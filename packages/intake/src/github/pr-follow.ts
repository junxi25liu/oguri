/**
 * Follow the pull requests chat-origin tasks report, and close the loop when
 * one merges (ADR 0030 §8).
 *
 * A run's result often names a pull request, and the person who asked cares
 * about the merge, not the run. Intake asks the GitHub CLI about each PR at
 * most once a minute. On a merge it sends one closing note to the chat and
 * completes the task if it is still open; on a close without merge it says
 * so. Either way the PR is settled and never asked about again.
 *
 * The CLI is run with execFile, an argv and no shell, under a timeout; the URL
 * it is given has already matched a strict pattern. State lives in `prs.json`
 * in the intake state directory, so a restart neither re-sends a note nor
 * forgets what it follows.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";

import type { TaskStatus } from "@oguri/core";
import { compareUlid, isUlid, ulidTime, type Message } from "@oguri/protocol";

import { readJson, writeJsonAtomic } from "../outbox/json-file.ts";
import type { Outbox } from "../outbox/types.ts";

export const PRS_FILE = "prs.json";
export const PR_CHECK_INTERVAL_MS = 60_000;
export const GH_TIMEOUT_MS = 15_000;
/** A PR still open this long after the event that named it is no longer followed. */
export const PR_FOLLOW_MS = 30 * 24 * 60 * 60_000;
/** Attempts to complete a task after its PR merged, before intake gives up and records why. */
export const MAX_COMPLETE_ATTEMPTS = 3;

export const MERGED_NOTE = (url: string): string => `PR merged: ${url}`;
export const CLOSED_NOTE = (url: string): string => `PR closed without merging: ${url}`;

const PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/;
const PR_URL_PREFIX =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}/;

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export interface FollowedPr {
  url: string;
  room: string;
  taskId: string;
  /** When the event that named it was written, ms since the epoch. */
  namedAt: number;
  state: PrState | "UNKNOWN";
  checkedAt?: number;
  mergedAt?: string;
  closedAt?: string;
  /** The last failure to read it, until a read succeeds. */
  error?: string;
  /** Merged or closed and handled: the note is queued and the task settled. */
  settled?: boolean;
  completeAttempts?: number;
  /** What happened to the task after the merge. */
  completion?: { at: string; outcome: "completed" | "already-done" | "refused"; detail?: string };
}

export interface PrFile {
  prs: Record<string, FollowedPr>;
}

/** What `gh pr view` printed. */
export interface PrView {
  state: PrState;
  mergedAt?: string;
  closedAt?: string;
  url?: string;
}

/** Run the GitHub CLI with an argv. Injectable, so tests need no `gh`. */
export type GhRunner = (
  argv: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<string>;

export const execGh: GhRunner = (argv, options) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      reject(new Error("githubCli is empty"));
      return;
    }
    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs,
        shell: false,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = String(stderr).trim().split("\n")[0] ?? "";
          reject(new Error(detail.length > 0 ? `${error.message}: ${detail}` : error.message));
          return;
        }
        resolve(String(stdout));
      },
    );
  });

/** The GitHub pull request URLs among a task event's refs, normalised and deduplicated. */
export function prUrlsIn(refs: readonly string[]): string[] {
  const urls: string[] = [];
  for (const ref of refs) {
    const match = PR_URL_PREFIX.exec(ref.trim());
    if (match === null) continue;
    const rest = ref.trim().slice(match[0].length);
    if (rest !== "" && !/^[/?#]/.test(rest)) continue;
    if (!urls.includes(match[0])) urls.push(match[0]);
  }
  return urls;
}

export function isPrUrl(value: string): boolean {
  return PR_URL.test(value);
}

export async function readPrState(stateDir: string): Promise<PrFile> {
  const raw = (await readJson(join(stateDir, PRS_FILE))) as Partial<PrFile> | null;
  const prs: Record<string, FollowedPr> = {};
  for (const [url, entry] of Object.entries(raw?.prs ?? {})) {
    if (isPrUrl(url) && entry !== null && typeof entry === "object" && entry.url === url) {
      prs[url] = entry;
    }
  }
  return { prs };
}

export function parsePrView(stdout: string): PrView {
  const value = JSON.parse(stdout) as Record<string, unknown>;
  const state = value["state"];
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
    throw new Error(`gh pr view: unexpected state ${JSON.stringify(state)}`);
  }
  const text = (key: string): string | undefined =>
    typeof value[key] === "string" && value[key] !== "" ? value[key] : undefined;
  const mergedAt = text("mergedAt");
  const closedAt = text("closedAt");
  const url = text("url");
  return {
    state,
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(url === undefined ? {} : { url }),
  };
}

/** One task's PRs, from its newest accepted completed or progressed event that names any. */
export interface TaskPrs {
  room: string;
  status: TaskStatus;
  urls: string[];
  namedAt: number;
}

/**
 * The PRs the chat-origin tasks in one room report.
 *
 * Reads the accepted events straight off the room: the events in the task's
 * thread that carry its snapshot, less the ones the reducer refused.
 */
export function taskPrs(
  room: string,
  messages: readonly Message[],
  statuses: readonly TaskStatus[],
): TaskPrs[] {
  const found: TaskPrs[] = [];
  for (const status of statuses) {
    if (status.task.origin === undefined || status.task.state === "cancelled") continue;
    const refused = new Set(status.invalidEvents.map((event) => event.messageId));
    const named = messages
      .filter(
        (message) =>
          message.header.thread === status.thread &&
          message.header.task?.id === status.task.id &&
          (message.header.task.action === "completed" ||
            message.header.task.action === "progressed") &&
          !refused.has(message.header.id),
      )
      .sort((a, b) => compareUlid(a.header.id, b.header.id))
      .findLast((message) => prUrlsIn(message.header.refs).length > 0);
    if (named === undefined) continue;
    found.push({
      room,
      status,
      urls: prUrlsIn(named.header.refs),
      namedAt: isUlid(named.header.id) ? ulidTime(named.header.id) : 0,
    });
  }
  return found;
}

export interface PrFollowOptions {
  githubCli: string;
  outbox: Outbox;
  stateDir: string;
  /** Complete a task this agent holds. Throws when the transition is refused. */
  completeTask(room: string, taskId: string, body: string, refs: string[]): Promise<unknown>;
  runGh?: GhRunner;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PrFollowReport {
  checked: string[];
  merged: string[];
  closed: string[];
  failed: { url: string; error: string }[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Check due PRs and act on the ones that merged or closed. */
export async function followPrs(
  found: readonly TaskPrs[],
  options: PrFollowOptions,
): Promise<PrFollowReport> {
  const now = (options.now ?? Date.now)();
  const runGh = options.runGh ?? execGh;
  const file = await readPrState(options.stateDir);
  const report: PrFollowReport = { checked: [], merged: [], closed: [], failed: [] };
  let changed = false;
  const save = async (): Promise<void> => {
    await writeJsonAtomic(join(options.stateDir, PRS_FILE), file);
  };

  for (const entry of found) {
    const origin = entry.status.task.origin;
    if (origin === undefined) continue;
    for (const url of entry.urls) {
      if (options.signal?.aborted === true) {
        if (changed) await save();
        return report;
      }
      let pr = file.prs[url];
      if (pr === undefined) {
        pr = {
          url,
          room: entry.room,
          taskId: entry.status.task.id,
          namedAt: entry.namedAt,
          state: "UNKNOWN",
        };
        file.prs[url] = pr;
        changed = true;
      }
      if (pr.settled === true || pr.taskId !== entry.status.task.id) continue;
      if (now - pr.namedAt > PR_FOLLOW_MS) continue;
      if (pr.checkedAt !== undefined && now - pr.checkedAt < PR_CHECK_INTERVAL_MS) continue;

      pr.checkedAt = now;
      changed = true;
      report.checked.push(url);
      let view: PrView;
      try {
        const stdout = await runGh(
          [options.githubCli, "pr", "view", url, "--json", "state,mergedAt,closedAt,url"],
          {
            timeoutMs: GH_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
        view = parsePrView(stdout);
      } catch (error) {
        pr.error = describe(error);
        report.failed.push({ url, error: pr.error });
        continue;
      }
      delete pr.error;
      pr.state = view.state;
      if (view.mergedAt !== undefined) pr.mergedAt = view.mergedAt;
      if (view.closedAt !== undefined) pr.closedAt = view.closedAt;
      if (view.state === "OPEN") continue;

      const reply = {
        source: origin.source,
        conversation: origin.conversation,
        replyTo: origin.message,
        purpose: "result" as const,
        taskId: entry.status.task.id,
      };
      if (view.state === "CLOSED") {
        await options.outbox.enqueue({
          ...reply,
          key: `pr-closed:${url}`,
          text: CLOSED_NOTE(url),
        });
        pr.settled = true;
        report.closed.push(url);
        continue;
      }

      await options.outbox.enqueue({ ...reply, key: `pr-merged:${url}`, text: MERGED_NOTE(url) });
      report.merged.push(url);
      const at = new Date(now).toISOString();
      const state = entry.status.task.state;
      if (state === "completed" || state === "cancelled") {
        pr.completion = { at, outcome: "already-done" };
        pr.settled = true;
        continue;
      }
      try {
        pr.completeAttempts = (pr.completeAttempts ?? 0) + 1;
        await options.completeTask(entry.room, entry.status.task.id, MERGED_NOTE(url), [url]);
        pr.completion = { at, outcome: "completed" };
        pr.settled = true;
      } catch (error) {
        pr.completion = { at, outcome: "refused", detail: describe(error) };
        // Retried on the next checks; after the last attempt the PR is settled
        // and the refusal stays on record. The closing note is queued either way.
        if ((pr.completeAttempts ?? 0) >= MAX_COMPLETE_ATTEMPTS) pr.settled = true;
        report.failed.push({ url, error: `could not complete the task: ${describe(error)}` });
      }
    }
  }
  if (changed) await save();
  return report;
}
