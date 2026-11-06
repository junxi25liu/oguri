/**
 * Start one executor and watch it until it ends.
 *
 * The command is argv with no shell, and the task text goes in on stdin. A
 * message body therefore never reaches a command line, whatever it contains.
 *
 * The executor leads its own process group. An agent run starts tools, test
 * runners, and servers of its own; signalling only the direct child would leave
 * those running, holding the output pipes open and the machine busy. Every
 * kill — timeout, cancellation, a forced stop — goes to the whole group.
 *
 * A run owns what it started. Once the executor itself has exited, whatever it
 * left in its group gets `DRAIN_LIMIT_MS` to finish, then SIGTERM, then SIGKILL;
 * and when the run ends the group is signalled once more, so a background job
 * that let go of the pipes does not outlive the run either. The timeout judges
 * the executor alone: a background job holding stdout open is not a run that
 * failed to finish. There is no way to keep a background service past its run.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RunRequest {
  argv: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** Directory that receives `stdout.log` and `stderr.log`. */
  logDir: string;
  env?: NodeJS.ProcessEnv;
  /** Aborting stops the run through the same SIGTERM-then-SIGKILL path as a timeout. */
  signal?: AbortSignal;
  /** Called once the process exists, so the caller can record its pid. */
  onSpawn?: (pid: number) => void;
  /**
   * A live session (ADR 0032): stdin stays open and takes one stream-json user
   * message per turn. The prompt is the first. `bind` hands the caller a way to
   * write another while the session runs; it returns false once stdin is
   * closed. Stdin closes when every message has its `result` and nothing waits.
   */
  live?: {
    bind: (send: (text: string) => boolean) => void;
    /**
     * The runner echoes each user message as it reads it
     * (`--replay-user-messages`). Claude folds a message written mid-turn into
     * that turn, so a turn's `result` may answer several messages; only the
     * echoes say which were read. Without them, one result per message.
     */
    replay?: boolean;
  };
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** The run was stopped through `RunRequest.signal`. */
  aborted?: boolean;
  durationMs: number;
  /**
   * How many processes the executor left running in its group when the run
   * ended, which the runner then stopped. Zero when nothing was left; one when
   * the process table cannot be read but the group was still there.
   */
  reapedBackground?: number;
  /**
   * A live session only: how many of the messages written to stdin (the prompt
   * is the first) the session is known to have read. With the echo on that is
   * the echoes seen; without it, the results seen, one per message. A message
   * past this count may never have been read, so it is not consumed.
   */
  messagesRead?: number;
  /** The end of stdout, which is where agents put their final answer. */
  stdoutTail: string;
  /** Set when the process could not be started at all. */
  error?: string;
}

export type Executor = (request: RunRequest) => Promise<RunResult>;

const TAIL_BYTES = 64 * 1024;
/** Grace between SIGTERM and SIGKILL, so an agent can flush what it has. */
const KILL_GRACE_MS = 5_000;
/** How long what an executor left running may go on once the executor has exited. */
export const DRAIN_LIMIT_MS = 10_000;

/**
 * Live processes in a group other than its leader. Zero when the group is gone,
 * and one when it exists but the process table cannot be read (a sandbox may
 * deny `ps`), so "something was there" is never reported as "nothing".
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: a group exists, it just is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function groupMembers(pgid: number): Promise<number> {
  if (!groupAlive(pgid)) return 0;
  try {
    const { stdout } = await exec("ps", ["-A", "-o", "pgid=,pid=,stat="], {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    let count = 0;
    for (const line of stdout.split("\n")) {
      const [group, pid, stat] = line.trim().split(/\s+/);
      if (group === String(pgid) && pid !== String(pgid) && !(stat ?? "").startsWith("Z")) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 1;
  }
}

/**
 * Signal a whole process group, falling back to the one process.
 *
 * The fallback covers a child that was not started as a group leader, and a
 * platform where negative pids mean nothing. Returns false when neither reached
 * a process, which usually means it has already exited.
 */
export function killGroup(pid: number, signal: NodeJS.Signals, child?: ChildProcess): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      if (child !== undefined) return child.kill(signal);
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export const runExecutor: Executor = async (request) => {
  await mkdir(request.logDir, { recursive: true, mode: 0o700 });
  const stdoutLog = createWriteStream(join(request.logDir, "stdout.log"), { mode: 0o600 });
  const stderrLog = createWriteStream(join(request.logDir, "stderr.log"), { mode: 0o600 });
  const started = Date.now();
  const [command, ...args] = request.argv as [string, ...string[]];

  return await new Promise<RunResult>((resolve) => {
    let tail = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let settling = false;
    /** Processes still running when the drain limit ran out. */
    let drained = 0;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;
    /** Live session: messages written to stdin, and how many the session is known to have read. */
    let written = 0;
    let read = 0;

    const child = spawn(command, args, {
      cwd: request.cwd,
      env: request.env ?? process.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) request.onSpawn?.(child.pid);

    const stop = (): void => {
      if (killTimer !== undefined) return;
      const pid = child.pid;
      if (pid === undefined) return;
      killGroup(pid, "SIGTERM", child);
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL", child), KILL_GRACE_MS);
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };

    /**
     * The run is over: stop whatever is still in the executor's group and wait
     * for it to go. Done before the run resolves, never on a timer that could
     * outlive it, because a group id that has emptied can be handed to an
     * unrelated process.
     */
    const reap = async (): Promise<number> => {
      const pid = child.pid;
      if (pid === undefined) return 0;
      const members = await groupMembers(pid);
      if (members === 0) return 0;
      killGroup(pid, "SIGTERM", child);
      const deadline = Date.now() + KILL_GRACE_MS;
      while (Date.now() < deadline && groupAlive(pid)) {
        await new Promise((wake) => setTimeout(wake, 50));
      }
      if (groupAlive(pid)) killGroup(pid, "SIGKILL", child);
      return members;
    };

    const finish = (
      result: Omit<RunResult, "durationMs" | "stdoutTail" | "aborted" | "messagesRead">,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
      request.signal?.removeEventListener("abort", onAbort);
      stdoutLog.end();
      stderrLog.end();
      resolve({
        ...result,
        ...(aborted ? { aborted } : {}),
        ...(request.live === undefined ? {} : { messagesRead: read }),
        durationMs: Date.now() - started,
        stdoutTail: tail.toString("utf8"),
      });
    };

    const timer = setTimeout(() => {
      // The limit is the executor's. One that already exited met it.
      if (exited) return;
      timedOut = true;
      stop();
    }, request.timeoutMs);

    if (request.signal?.aborted === true) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLog.write(chunk);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    });
    child.stderr.on("data", (chunk: Buffer) => stderrLog.write(chunk));

    child.on("error", (error) => {
      finish({ exitCode: null, signal: null, timedOut, error: error.message });
    });
    // The executor is done when it exits, not when its pipes close: a
    // background job that inherited them keeps `close` away indefinitely.
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timer);
      drainTimer = setTimeout(() => {
        const pid = child.pid;
        void (pid === undefined ? Promise.resolve(0) : groupMembers(pid)).then((left) => {
          drained = left;
          stop();
          // A pipe held by something outside the group would never close.
          giveUpTimer = setTimeout(settle, KILL_GRACE_MS + 1_000);
        });
      }, DRAIN_LIMIT_MS);
    });
    const settle = (): void => {
      if (settled || settling) return;
      settling = true;
      void reap()
        .then((reapedBackground) => Math.max(reapedBackground, drained))
        .then((reapedBackground) =>
          finish({ exitCode, signal: exitSignal, timedOut, reapedBackground }),
        );
    };
    child.on("close", (code, signal) => {
      if (!exited) {
        exitCode = code;
        exitSignal = signal;
      }
      settle();
    });

    // An executor that ignores stdin closes the pipe early; that is its choice,
    // not a failure of the run.
    child.stdin.on("error", () => undefined);
    if (request.live === undefined) {
      child.stdin.end(request.prompt);
      return;
    }

    // A live session: one user message per turn, written as it arrives.
    let results = 0;
    let replayed = 0;
    /** A result arrived after the last echo: everything echoed is answered. */
    let answered = false;
    let closed = false;
    let pending = "";
    const replay = request.live.replay === true;
    const send = (text: string): boolean => {
      if (closed || settled) return false;
      written += 1;
      child.stdin.write(`${streamUserMessage(text)}\n`);
      return true;
    };
    const closeIfDone = (): void => {
      const done = replay ? replayed >= written && answered : results >= written;
      if (!closed && done) {
        closed = true;
        child.stdin.end();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (isResultLine(line)) {
          results += 1;
          if (!replay) read = results;
          answered = true;
          // A message written during this turn has a turn of its own coming.
          closeIfDone();
        } else if (replay && isReplayLine(line)) {
          replayed += 1;
          read = replayed;
          answered = false;
        }
        newline = pending.indexOf("\n");
      }
    });
    request.live.bind(send);
    send(request.prompt);
  });
};

/** One user turn, as `claude -p --input-format stream-json` reads it. */
export function streamUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** True for a stream-json line echoing a user message the session read. */
export function isReplayLine(line: string): boolean {
  if (!line.includes('"user"')) return false;
  try {
    const value = JSON.parse(line) as {
      type?: unknown;
      isReplay?: unknown;
      message?: { content?: unknown };
    };
    if (value.type !== "user" || value.isReplay !== true) return false;
    // A tool result also comes back as a user message; only text is ours.
    const content = value.message?.content;
    return (
      Array.isArray(content) && content.some((part) => (part as { type?: unknown }).type === "text")
    );
  } catch {
    return false;
  }
}

/** True for a stream-json line that ends a turn. */
export function isResultLine(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return value.type === "result";
  } catch {
    return false;
  }
}
