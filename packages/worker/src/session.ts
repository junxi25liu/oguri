/**
 * One agent session per task (ADR 0030).
 *
 * A runner that declares `session` tells the worker where a run's session id
 * comes from. The worker records the id in `run.json`, and a later follow-up
 * on the same task runs the runner's `resume` argv with the id in place of
 * `{session}`, so the agent picks up where it stopped instead of starting cold.
 *
 * The id comes from the run's own output, which the worker does not trust. It
 * becomes one argv element of the next run, so it is held to a small alphabet
 * and may not start with `-`: an id can never turn into a flag.
 */

import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SESSION_TOKEN, type SessionMode } from "@oguri/core";

/** The file a `file` runner writes its session id to, inside its run directory. */
export const SESSION_FILE = "session-id";
/** How much of stdout is read to find the session. A JSON result larger than this is not parsed. */
const STDOUT_LIMIT = 4 * 1024 * 1024;
const SESSION_FILE_LIMIT = 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface SessionRead {
  /** The session id, when the run reported a valid one. */
  sessionId?: string;
  /** The agent's final answer, when the output format carries one apart from the log. */
  text?: string;
}

export function sessionFile(runDir: string): string {
  return join(runDir, SESSION_FILE);
}

export function validSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** `argv` with `{session}` replaced by the id. The policy parser guarantees exactly one token. */
export function resumeArgv(resume: readonly string[], sessionId: string): string[] {
  if (!validSessionId(sessionId))
    throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
  return resume.map((part) => part.replace(SESSION_TOKEN, sessionId));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `claude -p --output-format json`: one object with `session_id` and `result`. */
/**
 * The JSON a CLI printed, past any notice it printed first. Claude Code may
 * put a plain-text notice (about billing, an update) on stdout before its
 * JSON; the JSON is then the last line that parses.
 */
export function lastJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // a notice came first
  }
  const lines = trimmed.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(lines.slice(index).join("\n"));
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseClaudeJson(stdout: string): SessionRead {
  const parsed = lastJson(stdout);
  if (parsed === undefined) return {};
  // Some versions print an array of events; the result event is the last one.
  const object = Array.isArray(parsed)
    ? [...parsed]
        .reverse()
        .map(record)
        .find((event) => event?.["session_id"] !== undefined)
    : record(parsed);
  if (object === null || object === undefined) return {};
  const id = object["session_id"];
  const text = object["result"];
  return {
    ...(validSessionId(id) ? { sessionId: id } : {}),
    ...(typeof text === "string" && text.trim().length > 0 ? { text } : {}),
  };
}

/**
 * `codex exec --json`: JSON lines. The id is the first `thread.started`
 * event's `thread_id`, or the first `session_id` any line carries. The last
 * agent message is the final answer.
 */
/**
 * `claude -p --output-format stream-json`: JSON lines. The id is on the init
 * and result events; the text is the last turn's `result`, which answers
 * everything the session was told.
 */
export function parseClaudeStream(stdout: string): SessionRead {
  let sessionId: string | undefined;
  let text: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.includes("session_id") && !line.includes('"result"')) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (validSessionId(value["session_id"])) sessionId = value["session_id"];
    if (value["type"] === "result" && typeof value["result"] === "string") text = value["result"];
  }
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(text === undefined ? {} : { text }),
  };
}

export function parseCodexJsonl(stdout: string): SessionRead {
  let sessionId: string | undefined;
  let text: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trimStart().startsWith("{")) continue;
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event === null) continue;
    if (sessionId === undefined) {
      const id = event["type"] === "thread.started" ? event["thread_id"] : event["session_id"];
      if (validSessionId(id)) sessionId = id;
    }
    const item = record(event["item"]);
    if (event["type"] === "item.completed" && item?.["type"] === "agent_message") {
      const message = item["text"];
      if (typeof message === "string" && message.trim().length > 0) text = message;
    }
  }
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(text === undefined ? {} : { text }),
  };
}

/** Read up to `limit` bytes from the start of a file, or "" when it cannot be read. */
async function head(path: string, limit: number): Promise<string> {
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** The `file` mode: a regular file, small, holding one id. */
async function readSessionFile(path: string): Promise<SessionRead> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > SESSION_FILE_LIMIT) return {};
    const id = (await readFile(path, "utf8")).trim();
    return validSessionId(id) ? { sessionId: id } : {};
  } catch {
    return {};
  }
}

/**
 * Learn a finished run's session, by the runner's declared mode.
 *
 * Reads the full `stdout.log` rather than the in-memory tail: a codex session
 * id is on the first line, and a long claude result outgrows the tail.
 */
export async function readSession(mode: SessionMode, runDir: string): Promise<SessionRead> {
  if (mode === "file") return await readSessionFile(sessionFile(runDir));
  const stdoutPath = join(runDir, "stdout.log");
  let size = 0;
  try {
    size = (await lstat(stdoutPath)).size;
  } catch {
    return {};
  }
  if (mode === "claude-json" && size > STDOUT_LIMIT) return {};
  if (mode === "claude-stream") {
    // Every event carries the id, and the answer is the last result: read the end.
    return parseClaudeStream(await tail(stdoutPath, size, STDOUT_LIMIT));
  }
  const stdout = await head(stdoutPath, Math.min(size, STDOUT_LIMIT));
  return mode === "claude-json" ? parseClaudeJson(stdout) : parseCodexJsonl(stdout);
}

/** The last `limit` bytes of a file, from the first whole line in them. */
async function tail(path: string, size: number, limit: number): Promise<string> {
  const start = Math.max(0, size - limit);
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, size - start, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
