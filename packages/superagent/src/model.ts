/**
 * Ask a superagent's model once (ADR 0031).
 *
 * The same safety rules as the worker and `oguri plan`: the command is argv
 * from an entry of this machine's `worker.runners`, never a shell; the prompt
 * goes in on stdin; the process leads its own group and every kill reaches the
 * whole group; the run is bounded by the superagent's timeout.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionMode, WorkerPolicy } from "@oguri/core";
import { withRunnerModel } from "@oguri/core";

export interface RouterRunner {
  name: string;
  argv: string[];
  cwd: string;
  /** How the runner continues a session, when it can (ADR 0033). */
  resume?: string[];
  session?: SessionMode;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * The runner a superagent thinks with: the one it names, then `worker.plannerRunner`,
 * then `worker.defaultRunner`, then the first runner listed. Only names on
 * `worker.runners` resolve, so a superagent never runs a command the owner did not write.
 */
export function resolveThinker(worker: WorkerPolicy, requested?: string): RouterRunner {
  const names = Object.keys(worker.runners);
  const name = requested ?? worker.plannerRunner ?? worker.defaultRunner ?? names[0];
  if (name === undefined) {
    throw new Error("no runner is configured; add one under worker.runners in policy.yaml");
  }
  const runner = worker.runners[name];
  if (runner === undefined) {
    throw new Error(
      `runner '${name}' is not on this machine's allow-list (worker.runners: ${names.join(", ") || "none"})`,
    );
  }
  // A superagent reads and decides; it never runs in a worker's directory.
  return {
    name,
    argv: withRunnerModel(runner.argv, runner.model),
    cwd: expandHome(runner.workdir ?? worker.workdir ?? "~"),
    ...(runner.resume === undefined
      ? {}
      : { resume: withRunnerModel(runner.resume, runner.model) }),
    ...(runner.session === undefined ? {} : { session: runner.session }),
  };
}

export interface ModelResult {
  ok: boolean;
  stdout: string;
  /** Why the call failed, for the log; never sent to a chat. */
  error?: string;
}

export type AskModel = (request: {
  argv: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<ModelResult>;

const MAX_STDOUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 5_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export const askModel: AskModel = async (request) => {
  const [command, ...args] = request.argv as [string, ...string[]];
  return await new Promise<ModelResult>((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: process.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = (): void => {
      if (killTimer !== undefined || child.pid === undefined) return;
      const pid = child.pid;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const finish = (result: ModelResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", stop);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, request.timeoutMs);
    if (request.signal?.aborted === true) stop();
    else request.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_STDOUT_BYTES) stop();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => finish({ ok: false, stdout: "", error: error.message }));
    child.on("close", (code, signal) => {
      const text = stdout.toString("utf8");
      if (timedOut)
        finish({
          ok: false,
          stdout: text,
          error: `timed out after ${String(request.timeoutMs / 1000)}s`,
        });
      else if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-2).join(" | ");
        finish({
          ok: false,
          stdout: text,
          error: `exited with ${String(code ?? signal)}${tail === "" ? "" : `: ${tail}`}`,
        });
      } else finish({ ok: true, stdout: text });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.prompt);
  });
};
