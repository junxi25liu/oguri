/**
 * Is the process a run record names still the one that wrote it?
 *
 * A pid alone is not enough. After a reboot the pid of a dead worker is free,
 * and some unrelated process may hold it. Treating that process as the worker
 * would leave the task stuck forever; treating it as an orphaned run and
 * killing it would be far worse. So a live pid also has to have started no
 * later than the moment the record says it did.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** `ps` reports start time to the second; this absorbs the rounding and a little clock skew. */
const START_TOLERANCE_MS = 2_000;

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When a process started, or null when this platform cannot say. */
export async function processStartTime(pid: number): Promise<number | null> {
  // Our own uptime is known even when a sandbox denies external process inspection.
  // Do not infer the start time of any other process when inspection is unavailable.
  if (pid === process.pid) return Date.now() - process.uptime() * 1_000;
  try {
    const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * True when `pid` is alive and plausibly the process that started by `startedBy`.
 *
 * No pid means gone: a record written before pids were recorded, or a run that
 * never got as far as starting its executor.
 */
export async function sameProcessAlive(
  pid: number | undefined,
  startedBy: number,
): Promise<boolean> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  if (!pidExists(pid)) return false;
  const started = await processStartTime(pid);
  // Unknown start time: trust the pid rather than risk killing a live run.
  if (started === null) return true;
  return started <= startedBy + START_TOLERANCE_MS;
}
