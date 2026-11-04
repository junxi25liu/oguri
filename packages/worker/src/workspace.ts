/**
 * Where a run executes.
 *
 * Two runs that share a checkout overwrite each other's edits and race on the
 * index. A runner with `worktree: true` therefore gets a fresh git worktree of
 * its repository for every run, on its own branch, inside the run directory.
 *
 * The worktree stays after the run. It holds the work, and deleting work is a
 * decision for the person who reads the result, not for the worker.
 *
 * This is the user's own project repository, never the transport repository:
 * the worker still never touches oguri's git (ADR 0005).
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export interface Workspace {
  cwd: string;
  worktree?: { path: string; branch: string };
}

/** Branch for one run. Task and run ids are ULIDs, so the name is always a valid ref. */
export function worktreeBranch(taskId: string, runId: string): string {
  return `oguri/${taskId}-${runId}`;
}

function gitError(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim().split("\n")[0]!;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prepare the directory a run starts in.
 *
 * Without a worktree this is just `workdir`. With one, `workdir` must be a git
 * repository, and the worktree is created from its current HEAD at
 * `<runDir>/work`. Throws with a reason a person can act on.
 */
export async function prepareWorkspace(options: {
  workdir: string;
  worktree: boolean;
  runDir: string;
  taskId: string;
  runId: string;
}): Promise<Workspace> {
  if (!options.worktree) return { cwd: options.workdir };

  try {
    await exec("git", ["-C", options.workdir, "rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    throw new Error(`${options.workdir} is not a git repository: ${gitError(error)}`);
  }
  const path = join(options.runDir, "work");
  const branch = worktreeBranch(options.taskId, options.runId);
  try {
    await exec("git", [
      "-C",
      options.workdir,
      "worktree",
      "add",
      "--quiet",
      "-b",
      branch,
      path,
      "HEAD",
    ]);
  } catch (error) {
    throw new Error(`could not create a git worktree of ${options.workdir}: ${gitError(error)}`);
  }
  return { cwd: path, worktree: { path, branch } };
}
