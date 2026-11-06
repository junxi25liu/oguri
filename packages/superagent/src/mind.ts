/**
 * A superagent's standing session (ADR 0033).
 *
 * A standing superagent session is one long-lived model session: new requests,
 * worker reports, and notices arrive in it as messages, and it keeps its
 * context between them. A superagent here keeps one too, as far as the
 * owner's allow-listed runner can:
 *
 * - `session: claude-stream`: one Claude process stays up; each turn is a user
 *   message written to its stdin, answered by the next `result`. When the
 *   process ends, the next turn resumes the same session with `resume`.
 * - `session: claude-json` or `codex-jsonl`, with `resume`: one process per
 *   turn, each resuming the session the last one left.
 * - anything else: one call per turn with everything in it, as before.
 *
 * The session is a view, never the record: every turn carries a fresh
 * snapshot of the transport repository, and every reply is checked in code. A
 * session starts afresh when its standing rules change, not after a
 * fixed number of turns. Long-context compaction belongs to the runner.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describeError, SESSION_TOKEN, type SessionMode } from "@oguri/core";

import { askModel, type AskModel, type ModelResult } from "./model.ts";

const KILL_GRACE_MS = 5_000;
const MAX_LINE_BYTES = 1024 * 1024;

export interface ThinkerRunner {
  name: string;
  argv: string[];
  cwd: string;
  resume?: string[];
  session?: SessionMode;
}

export interface TurnRequest {
  /** What a fresh session is told first: the role, the kinds, the rules. */
  rules: string;
  /** This turn only. */
  turn: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Mind {
  /** How it keeps context: `stream`, `resume`, or `none`. */
  readonly kind: "stream" | "resume" | "none";
  turn(request: TurnRequest): Promise<ModelResult>;
  /** True when the next turn continues a session that already has the rules. */
  primed(rules: string): Promise<boolean>;
  close(): Promise<void>;
}

/** What survives a restart: which session, under which rules, how far along. */
export interface SessionRecord {
  id?: string;
  rules?: string;
  turns: number;
  startedAt?: string;
}

export class SessionStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<SessionRecord> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<SessionRecord>;
      return {
        ...(typeof value.id === "string" && /^[\w.:-]{1,200}$/.test(value.id)
          ? { id: value.id }
          : {}),
        ...(typeof value.rules === "string" ? { rules: value.rules } : {}),
        turns: typeof value.turns === "number" && value.turns >= 0 ? value.turns : 0,
        ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
      };
    } catch {
      return { turns: 0 };
    }
  }

  async write(record: SessionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export function sessionStorePath(home: string, name: string): string {
  return join(home, "superagent", `${name}-session.json`);
}

export function rulesHash(rules: string): string {
  return createHash("sha256").update(rules).digest("hex").slice(0, 16);
}

/** The session continues: same rules and an id to resume, regardless of turn count. */
function continues(record: SessionRecord, rules: string): boolean {
  return record.id !== undefined && record.rules === rulesHash(rules);
}

function resumeArgv(resume: readonly string[], id: string): string[] {
  return resume.map((part) => part.split(SESSION_TOKEN).join(id));
}

function withRules(rules: string, turn: string): string {
  return `${rules}\n\n${turn}`;
}

/** One call per turn with everything in it. */
export class OneShotMind implements Mind {
  readonly kind = "none" as const;
  private readonly runner: ThinkerRunner;
  private readonly ask: AskModel;

  constructor(runner: ThinkerRunner, ask: AskModel = askModel) {
    this.runner = runner;
    this.ask = ask;
  }

  async turn(request: TurnRequest): Promise<ModelResult> {
    return await this.ask({
      argv: this.runner.argv,
      cwd: this.runner.cwd,
      prompt: withRules(request.rules, request.turn),
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  async primed(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}
}

/** The session id a finished `claude-json` or `codex-jsonl` call printed. */
export function sessionIdOf(mode: SessionMode, stdout: string): string | undefined {
  const valid = (value: unknown): value is string =>
    typeof value === "string" && /^[\w.:-]{1,200}$/.test(value);
  if (mode === "claude-json") {
    // Claude Code may print a plain-text notice before its JSON.
    for (const line of stdout.trim().split("\n").reverse()) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (valid(value["session_id"])) return value["session_id"];
      } catch {
        continue;
      }
    }
    return undefined;
  }
  for (const line of stdout.split("\n")) {
    if (!line.includes("thread") && !line.includes("session")) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value["type"] === "thread.started" && valid(value["thread_id"]))
        return value["thread_id"];
      if (valid(value["session_id"])) return value["session_id"];
    } catch {
      continue;
    }
  }
  return undefined;
}

/** One process per turn, each resuming the session the last one left. */
export class ResumeMind implements Mind {
  readonly kind = "resume" as const;
  private readonly runner: ThinkerRunner & { resume: string[]; session: SessionMode };
  private readonly store: SessionStore;
  private readonly ask: AskModel;
  private readonly log: (line: string) => void;

  constructor(
    runner: ThinkerRunner & { resume: string[]; session: SessionMode },
    store: SessionStore,
    ask: AskModel = askModel,
    log: (line: string) => void = () => undefined,
  ) {
    this.runner = runner;
    this.store = store;
    this.ask = ask;
    this.log = log;
  }

  async primed(rules: string): Promise<boolean> {
    return continues(await this.store.read(), rules);
  }

  async turn(request: TurnRequest): Promise<ModelResult> {
    let record = await this.store.read();
    const call = async (resuming: boolean): Promise<ModelResult> =>
      await this.ask({
        argv: resuming
          ? resumeArgv(this.runner.resume, record.id as string)
          : [...this.runner.argv],
        cwd: this.runner.cwd,
        prompt: resuming ? request.turn : withRules(request.rules, request.turn),
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    const resuming = continues(record, request.rules);
    let result = await call(resuming);
    if (!result.ok && resuming && request.signal?.aborted !== true) {
      // A session that cannot be resumed (gone, or refused) starts afresh once.
      this.log(`could not resume session ${record.id ?? ""}: ${result.error ?? "failed"}`);
      record = { turns: 0 };
      result = await call(false);
    }
    if (!result.ok) return result;
    const id = sessionIdOf(this.runner.session, result.stdout);
    const fresh = !resuming || record.id === undefined;
    record =
      id === undefined
        ? { turns: 0 }
        : {
            id,
            rules: rulesHash(request.rules),
            turns: (fresh ? 0 : record.turns) + 1,
            startedAt: fresh
              ? new Date().toISOString()
              : (record.startedAt ?? new Date().toISOString()),
          };
    await this.store.write(record);
    return result;
  }

  async close(): Promise<void> {}
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function userMessage(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

interface Waiter {
  resolve: (result: ModelResult) => void;
  /** The process this turn was written to; only its exit ends the turn. */
  child: ChildProcess;
}

/**
 * One Claude process that stays up, as a standing superagent session does.
 * Turns are serial: each writes one user message and waits for its `result`.
 */
export class StreamMind implements Mind {
  readonly kind = "stream" as const;
  private child: ChildProcess | undefined;
  private buffer = "";
  private waiter: Waiter | undefined;
  /** The live process has the rules of this hash. */
  private processRules: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly runner: ThinkerRunner;
  private readonly store: SessionStore;
  private readonly log: (line: string) => void;

  constructor(
    runner: ThinkerRunner,
    store: SessionStore,
    log: (line: string) => void = () => undefined,
  ) {
    this.runner = runner;
    this.store = store;
    this.log = log;
  }

  async primed(rules: string): Promise<boolean> {
    if (this.child !== undefined && this.processRules === rulesHash(rules)) return true;
    return this.runner.resume !== undefined && continues(await this.store.read(), rules);
  }

  turn(request: TurnRequest): Promise<ModelResult> {
    const next = this.chain.then(async () => await this.run(request));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async run(request: TurnRequest): Promise<ModelResult> {
    let record = await this.store.read();
    const hash = rulesHash(request.rules);
    if (record.rules !== undefined && record.rules !== hash) {
      // New standing rules: start afresh. Context compaction belongs to the runner.
      await this.stop();
      record = { turns: 0 };
      await this.store.write(record);
    }
    let primed = this.child !== undefined && this.processRules === hash;
    if (!primed && this.child !== undefined) await this.stop();
    if (this.child === undefined) {
      const resuming = this.runner.resume !== undefined && continues(record, request.rules);
      const argv = resuming
        ? resumeArgv(this.runner.resume as string[], record.id as string)
        : [...this.runner.argv];
      if (!resuming) record = { turns: 0 };
      const started = this.start(argv);
      if (started !== null) return { ok: false, stdout: "", error: started };
      primed = resuming;
      if (resuming) this.processRules = hash;
    }
    const text = primed ? request.turn : withRules(request.rules, request.turn);
    const result = await this.exchange(text, request);
    if (!result.ok) {
      if (!primed && record.id === undefined) this.processRules = undefined;
      return result;
    }
    this.processRules = hash;
    const id = streamSessionId(result.stdout) ?? record.id;
    const fresh = record.id === undefined || record.id !== id;
    await this.store.write({
      ...(id === undefined ? {} : { id }),
      rules: hash,
      turns: (fresh ? 0 : record.turns) + 1,
      startedAt: fresh ? new Date().toISOString() : (record.startedAt ?? new Date().toISOString()),
    });
    return result;
  }

  /** Start the process; returns why it could not, or null. */
  private start(argv: string[]): string | null {
    const [command, ...args] = argv as [string, ...string[]];
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: this.runner.cwd,
        env: process.env,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return describeError(error);
    }
    this.child = child;
    this.buffer = "";
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
    const gone = (why: string): void => {
      if (this.child === child) {
        this.child = undefined;
        this.processRules = undefined;
      }
      // A process stopped after a timeout ends later; the turn waiting then is
      // another process's.
      const waiter = this.waiter;
      if (waiter?.child !== child) return;
      this.waiter = undefined;
      waiter.resolve({ ok: false, stdout: "", error: why });
    };
    child.on("error", (error) => gone(error.message));
    child.on("close", (code, signal) =>
      gone(`the session ended (${signal ?? `exit ${String(code)}`})`),
    );
    return null;
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_LINE_BYTES * 4) this.buffer = this.buffer.slice(-MAX_LINE_BYTES);
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.includes('"result"') && isResult(line)) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.resolve({ ok: true, stdout: line });
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private async exchange(text: string, request: TurnRequest): Promise<ModelResult> {
    const child = this.child;
    if (child?.stdin === null || child?.stdin === undefined) {
      return { ok: false, stdout: "", error: "the session is not running" };
    }
    return await new Promise<ModelResult>((resolve) => {
      let settled = false;
      const finish = (result: ModelResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        void this.stop();
        finish({ ok: false, stdout: "", error: "stopped" });
      };
      const timer = setTimeout(() => {
        // The session keeps its id; the next turn resumes it in a new process.
        this.log(
          `the session did not answer in ${String(request.timeoutMs / 1000)}s; restarting it`,
        );
        void this.stop();
        finish({ ok: false, stdout: "", error: "timed out" });
      }, request.timeoutMs);
      if (request.signal?.aborted === true) {
        onAbort();
        return;
      }
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = { resolve: finish, child };
      child.stdin?.write(userMessage(text));
    });
  }

  private async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.processRules = undefined;
    if (child === undefined || child.pid === undefined) return;
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
        resolve();
      }, KILL_GRACE_MS);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end();
      killGroup(pid, "SIGTERM");
    });
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.stop();
  }
}

function isResult(line: string): boolean {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === "result";
  } catch {
    return false;
  }
}

function streamSessionId(line: string): string | undefined {
  try {
    const value = (JSON.parse(line) as { session_id?: unknown }).session_id;
    return typeof value === "string" && /^[\w.:-]{1,200}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The standing session a runner allows. `ask` replaces the one-call model in
 * tests; a runner that keeps sessions still keeps them.
 */
export function mindFor(
  runner: ThinkerRunner,
  options: { home: string; name: string; ask?: AskModel; log?: (line: string) => void },
): Mind {
  const store = new SessionStore(sessionStorePath(options.home, options.name));
  if (runner.session === "claude-stream") return new StreamMind(runner, store, options.log);
  if (
    runner.resume !== undefined &&
    (runner.session === "claude-json" || runner.session === "codex-jsonl")
  ) {
    return new ResumeMind(
      runner as ThinkerRunner & { resume: string[]; session: SessionMode },
      store,
      options.ask,
      options.log,
    );
  }
  return new OneShotMind(runner, options.ask);
}

/**
 * The one standing session a superagent keeps, made again only when its
 * runner changes in `policy.yaml`.
 */
export class MindHolder {
  private mind: Mind | undefined;
  private key: string | undefined;
  private readonly options: {
    home: string;
    name: string;
    ask?: AskModel;
    log?: (line: string) => void;
  };

  constructor(options: {
    home: string;
    name: string;
    ask?: AskModel;
    log?: (line: string) => void;
  }) {
    this.options = options;
  }

  async get(runner: ThinkerRunner | undefined): Promise<Mind | undefined> {
    if (runner === undefined) return undefined;
    const key = JSON.stringify(runner);
    if (this.mind !== undefined && this.key === key) return this.mind;
    await this.mind?.close();
    this.mind = mindFor(runner, this.options);
    this.key = key;
    return this.mind;
  }

  async close(): Promise<void> {
    await this.mind?.close();
    this.mind = undefined;
    this.key = undefined;
  }
}
