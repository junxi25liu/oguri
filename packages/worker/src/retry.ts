/**
 * What happens to a task after its run failed, and when this machine may try it again.
 *
 * A failed run is not always the task's fault: a flaky test, a network blip, a
 * machine that ran out of disk. A task created with `maxAttempts` has said how
 * many tries it is worth (ADR 0027), so the worker hands it back while tries
 * remain and asks a person once they are used up.
 *
 * Handing it back to the room means any eligible machine may take it, this one
 * included. This one waits first: a machine that just failed a task is the one
 * most likely to fail it again the same way, and an immediate retry would spend
 * the hourly budget on a loop.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkerRetryPolicy } from "@oguri/core";

import { runsDir } from "./runs.ts";

export type FailureAction =
  { action: "released" } | { action: "blocked"; needsHuman: boolean; reason: string };

/**
 * Decide between `released` and `blocked` for a task whose run failed.
 *
 * `attempt` is the count after this run's claim. A task whose attempts are used
 * up is blocked for a person whatever the policy says: releasing it would leave
 * it open with nobody allowed to claim it.
 */
export function failureAction(
  task: { attempt?: number; maxAttempts?: number },
  retry: WorkerRetryPolicy,
): FailureAction {
  const attempt = task.attempt ?? 0;
  if (task.maxAttempts !== undefined && attempt >= task.maxAttempts) {
    return {
      action: "blocked",
      needsHuman: true,
      reason: `all ${String(task.maxAttempts)} attempt(s) are used`,
    };
  }
  const onFailure =
    retry.onFailure ??
    (task.maxAttempts !== undefined && task.maxAttempts > attempt ? "release" : "block");
  return onFailure === "release"
    ? { action: "released" }
    : { action: "blocked", needsHuman: false, reason: "worker.retry blocks a failed run" };
}

const FILE = "retry-after.json";

/**
 * Tasks this machine released after a failure, and when it may take each again.
 *
 * Kept in the runs directory, beside the run records, so a restart does not
 * turn a backoff into an immediate retry. Local only: another machine's
 * eligibility is none of this file's business.
 */
export class RetryBackoff {
  private readonly dir: string;
  private readonly path: string;
  private readonly now: () => number;
  private notBefore = new Map<string, number>();
  private loaded = false;

  constructor(home: string, now: () => number = Date.now) {
    this.dir = runsDir(home);
    this.path = join(this.dir, FILE);
    this.now = now;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
      for (const [taskId, at] of Object.entries(raw)) {
        const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
        if (Number.isFinite(time)) this.notBefore.set(taskId, time);
      }
    } catch {
      // Missing or unreadable: no backoff is known, which only allows a retry sooner.
    }
  }

  /** When this machine may claim the task again, or null when it may now. */
  async until(taskId: string): Promise<number | null> {
    await this.load();
    const at = this.notBefore.get(taskId);
    return at !== undefined && at > this.now() ? at : null;
  }

  async set(taskId: string, minutes: number): Promise<void> {
    await this.load();
    if (minutes <= 0) this.notBefore.delete(taskId);
    else this.notBefore.set(taskId, this.now() + minutes * 60_000);
    await this.save();
  }

  /** Expired entries are dropped on every write, so the file stays small. */
  private async save(): Promise<void> {
    const now = this.now();
    const live: Record<string, string> = {};
    for (const [taskId, at] of this.notBefore) {
      if (at > now) live[taskId] = new Date(at).toISOString();
      else this.notBefore.delete(taskId);
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${String(process.pid)}.tmp`;
    await writeFile(temp, `${JSON.stringify(live, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
  }
}
