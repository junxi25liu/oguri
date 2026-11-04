/**
 * The structured result an executor may leave behind.
 *
 * The end of stdout is a poor report: it is whatever the agent printed last,
 * often a progress bar or a closing pleasantry. So the worker offers each run a
 * file, `<run-dir>/result.json`, and tells the executor about it in the prompt
 * and in `OGURI_RESULT_FILE`. Writing it is optional.
 *
 * The file comes from a process the worker does not trust to be careful, and
 * what it says is published. So it is read strictly: a size cap, a regular file
 * only, no unknown keys, every value checked. Anything wrong and the whole file
 * is ignored, and the report says so.
 */

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { hasSecrets } from "@oguri/core";

export const RESULT_FILE = "result.json";
export const RESULT_FILE_LIMIT = 64 * 1024;

const RESULT_KEYS = ["summary", "branch", "pr", "artifacts", "needsHuman"] as const;
const MAX_ARTIFACTS = 32;
const MAX_REF_LENGTH = 500;
/** A question for a person is read on a phone; it does not need to be long. */
export const QUESTION_LIMIT = 2 * 1024;

/** What `result.json` may say. */
export interface StructuredResult {
  summary: string;
  branch?: string;
  pr?: string;
  artifacts?: string[];
  needsHuman?: string;
}

export type ResultRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; result: StructuredResult };

export function resultPath(runDir: string): string {
  return join(runDir, RESULT_FILE);
}

/**
 * The footer appended to every prompt.
 *
 * Plain text an agent reads like the rest of the task. It names the path as
 * well as the variable, because some executors cannot see their environment.
 */
export function resultFooter(path: string): string {
  return [
    "",
    "",
    "---",
    `oguri: when you finish, you may write a JSON result to ${path} (also in $OGURI_RESULT_FILE):`,
    '{"summary": "what you did, for the person who asked", "branch": "git branch with the work", "pr": "pull request URL", "artifacts": ["paths of files you produced"], "needsHuman": "a question a person must answer before this can finish"}',
    'Only "summary" is required. Without the file, the end of your output is reported instead.',
    "",
  ].join("\n");
}

function oneLine(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/** A branch name a ref can carry: git's own rules, minus the rarely-needed corners. */
function validBranch(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//")
  );
}

function validUrl(value: string): boolean {
  if (value.length > MAX_REF_LENGTH || !oneLine(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    // Credentials in a URL would be published with it.
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Check the parsed JSON against the schema. Returns the reason it fails, or the result. */
export function validateResult(value: unknown): StructuredResult | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "it is not a JSON object";
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) => !(RESULT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) return `unknown key(s): ${unknown.join(", ")}`;
  if (!nonEmpty(raw["summary"])) return '"summary" must be a non-empty string';

  const result: StructuredResult = { summary: raw["summary"].trim() };
  const branch = raw["branch"];
  if (branch !== undefined) {
    if (typeof branch !== "string" || !validBranch(branch)) {
      return '"branch" must be a git branch name';
    }
    result.branch = branch;
  }
  const pr = raw["pr"];
  if (pr !== undefined) {
    if (typeof pr !== "string" || !validUrl(pr)) return '"pr" must be an https URL';
    result.pr = pr;
  }
  const artifacts = raw["artifacts"];
  if (artifacts !== undefined) {
    if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS) {
      return `"artifacts" must be a list of at most ${String(MAX_ARTIFACTS)} paths`;
    }
    for (const path of artifacts) {
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        path.length > MAX_REF_LENGTH ||
        !oneLine(path)
      ) {
        return '"artifacts" must contain only single-line paths';
      }
    }
    result.artifacts = [...new Set(artifacts as string[])];
  }
  const needsHuman = raw["needsHuman"];
  if (needsHuman !== undefined) {
    if (!nonEmpty(needsHuman)) return '"needsHuman" must be a non-empty string';
    result.needsHuman = needsHuman.trim();
  }
  return result;
}

/**
 * Read and validate `result.json`.
 *
 * Only a regular file is read. A symlink would let an executor point the
 * worker at any file this user can read, and publish part of it.
 */
export async function readResult(path: string): Promise<ResultRead> {
  let size: number;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return { kind: "invalid", reason: "it is not a regular file" };
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: "it could not be read" };
  }
  if (size > RESULT_FILE_LIMIT) {
    return { kind: "invalid", reason: `it is larger than ${String(RESULT_FILE_LIMIT / 1024)} KiB` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // The parser's message can quote the file, so it is not repeated.
    return { kind: "invalid", reason: "it is not valid JSON" };
  }
  const result = validateResult(parsed);
  return typeof result === "string"
    ? { kind: "invalid", reason: result }
    : { kind: "valid", result };
}

/**
 * The refs a report carries.
 *
 * `branch:<name>` for a branch (the run's own worktree branch first), the pull
 * request URL as it is, and `artifact:<machine>:<absolute path>` for a file,
 * so a reader knows which machine holds it. A ref the secret scanner flags is
 * dropped, because refs are published as they are.
 */
export function resultRefs(options: {
  result?: StructuredResult;
  worktreeBranch?: string;
  machine: string;
  cwd: string;
}): { refs: string[]; dropped: number } {
  const candidates: string[] = [];
  if (options.worktreeBranch !== undefined) candidates.push(`branch:${options.worktreeBranch}`);
  const result = options.result;
  if (result?.branch !== undefined) candidates.push(`branch:${result.branch}`);
  if (result?.pr !== undefined) candidates.push(result.pr);
  for (const path of result?.artifacts ?? []) {
    const absolute = isAbsolute(path) ? path : resolve(options.cwd, path);
    candidates.push(`artifact:${options.machine}:${absolute}`);
  }
  const refs: string[] = [];
  let dropped = 0;
  for (const ref of new Set(candidates)) {
    if (ref.length > MAX_REF_LENGTH + 100 || hasSecrets(ref)) dropped += 1;
    else refs.push(ref);
  }
  return { refs, dropped };
}
