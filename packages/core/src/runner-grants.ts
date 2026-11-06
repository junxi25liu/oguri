import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ulid } from "@oguri/protocol";

import { Layout } from "./layout.ts";
import type { WorkerRunner } from "./policy.ts";

/**
 * Runner grants: a person's local, bounded consent that an allow-listed runner
 * may be started by the worker on this machine.
 *
 * `worker.runners` stays the complete set of commands. A grant never carries
 * an argv, so it cannot add one; it narrows which of those runners may run,
 * for whom, and until when. Each grant is bound to a digest of the runner
 * entry as the person saw it, so an edit to that entry afterwards — another
 * model, another tool, another flag — makes the grant stop applying rather
 * than silently authorising something nobody reviewed.
 *
 * Modelled on `ApprovalStore`, for the same two reasons: a grant is derivable
 * from nothing in git, so it must not live in the rebuildable `state.db`; and
 * it is a fact about this machine, so it is never published, where a peer
 * could read it as authority.
 *
 * **Off until a person turns it on.** With no `grants.json` every runner in
 * `worker.runners` runs exactly as before. The first `oguri runner grant`
 * creates the file, and from then on a runner runs only under a live grant.
 * A file that does not decode means "no grants", never "every grant".
 *
 * Requests are a separate, append-only file that agents may write. Writing
 * one can never create `grants.json`, so an agent asking cannot switch
 * enforcement on (or off) for the person.
 */

export const GRANTS_FILE = "grants.json";
export const RUNNER_REQUESTS_FILE = "runner-requests.jsonl";
export const RUNNER_AUDIT_FILE = "runner-audit.jsonl";

const FILE_VERSION = 1;
const RUNNER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_REASON = 1000;

/** Who issued or withdrew a grant. Recorded, never authenticated (see ADR 0012). */
export interface GrantActor {
  /** `agent.human.name` from this home's config. */
  human: string;
  /** The operating-system user that ran the command. */
  user: string;
  /** The agent identity the command ran under. */
  agent: string;
  /** Grants are only ever issued at a terminal. */
  via: "terminal";
}

export interface RunnerGrant {
  id: string;
  runner: string;
  /** `runnerDigest` of the entry the person reviewed when granting. */
  digest: string;
  /** Task creators this grant covers. Absent means any creator the worker already serves. */
  for?: string[];
  /** RFC 3339 UTC. */
  grantedAt: string;
  /** RFC 3339 UTC. Absent means until revoked. */
  expiresAt?: string;
  grantedBy: GrantActor;
  note?: string;
}

export interface RunnerRequest {
  id: string;
  runner: string;
  /** Who asked: an agent id. */
  by: string;
  via: "cli" | "mcp" | "worker";
  reason: string;
  at: string;
  /** The task that needs the runner, when one does. */
  taskId?: string;
  room?: string;
}

export const AUDIT_ACTIONS = ["grant", "revoke", "request", "refused", "denied"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  at: string;
  action: AuditAction;
  runner: string;
  /** The person behind a grant or revoke; an agent id for everything else. */
  actor: GrantActor | { agent: string; via: string };
  digest?: string;
  detail?: string;
}

/** What `grants.json` says right now. */
export interface GrantState {
  /** A grants file exists, so a runner needs a live grant to run. */
  enforced: boolean;
  /** The file exists but did not decode; nothing is granted until it is fixed. */
  corrupt: boolean;
  grants: RunnerGrant[];
}

export type GrantVerdict =
  { allowed: true; grant?: RunnerGrant } | { allowed: false; reason: string };

/**
 * A stable sha256 over everything in a runner entry that shapes what runs.
 *
 * The argv comes first, but `model`, `effort`, `resume` and the workspace keys
 * change the effective command or where it acts, so editing any of them is
 * also a change the person has not reviewed.
 */
export function runnerDigest(runner: WorkerRunner): string {
  const material = JSON.stringify([
    runner.argv,
    runner.resume ?? null,
    runner.model ?? null,
    runner.effort ?? null,
    runner.efforts ?? null,
    runner.session ?? null,
    runner.workdir ?? null,
    runner.worktree,
    runner.oguriTools ?? null,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** The first characters of a digest, enough to tell two apart in a log line. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodeActor(value: unknown): GrantActor | null {
  if (value === null || typeof value !== "object") return null;
  const actor = value as Partial<GrantActor>;
  if (typeof actor.human !== "string" || actor.human === "") return null;
  return {
    human: actor.human,
    user: typeof actor.user === "string" ? actor.user : "",
    agent: typeof actor.agent === "string" ? actor.agent : "",
    via: "terminal",
  };
}

/** Decode defensively: anything unreadable fails closed. */
export function decodeGrants(raw: string): GrantState {
  const closed: GrantState = { enforced: true, corrupt: true, grants: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return closed;
  }
  if (parsed === null || typeof parsed !== "object") return closed;
  const entries = (parsed as { grants?: unknown }).grants;
  if (!Array.isArray(entries)) return closed;

  const grants: RunnerGrant[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const grant = entry as Partial<RunnerGrant>;
    if (typeof grant.runner !== "string" || !RUNNER_NAME.test(grant.runner)) continue;
    if (typeof grant.digest !== "string" || !DIGEST.test(grant.digest)) continue;
    // A grant nobody can be traced to is not a grant.
    const grantedBy = decodeActor(grant.grantedBy);
    if (grantedBy === null) continue;
    if (grant.expiresAt !== undefined && !isIso(grant.expiresAt)) continue;
    const forList = Array.isArray(grant.for)
      ? grant.for.filter((id): id is string => typeof id === "string" && id !== "")
      : undefined;
    grants.push({
      id: typeof grant.id === "string" ? grant.id : "",
      runner: grant.runner,
      digest: grant.digest,
      ...(forList === undefined || forList.length === 0 ? {} : { for: forList }),
      grantedAt: isIso(grant.grantedAt) ? grant.grantedAt : new Date(0).toISOString(),
      ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
      grantedBy,
      ...(typeof grant.note === "string" ? { note: grant.note } : {}),
    });
  }
  return { enforced: true, corrupt: false, grants };
}

/**
 * May this runner run for this requester now?
 *
 * Without a grants file the answer is always yes, which is what keeps every
 * machine that never issued a grant working exactly as it did.
 */
export function checkGrant(
  state: GrantState,
  name: string,
  runner: WorkerRunner,
  requester: string,
  now: number = Date.now(),
): GrantVerdict {
  if (!state.enforced) return { allowed: true };
  if (state.corrupt) {
    return {
      allowed: false,
      reason: `${GRANTS_FILE} could not be read, so no runner is granted; fix or re-issue it with oguri runner grant`,
    };
  }
  const grant = state.grants.find((candidate) => candidate.runner === name);
  if (grant === undefined) {
    return {
      allowed: false,
      reason: `no runner grant covers '${name}'; a person grants it with: oguri runner grant ${name}`,
    };
  }
  if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now) {
    return {
      allowed: false,
      reason: `the grant for '${name}' expired at ${grant.expiresAt}; a person renews it with: oguri runner grant ${name}`,
    };
  }
  const digest = runnerDigest(runner);
  if (grant.digest !== digest) {
    return {
      allowed: false,
      reason: `the grant for '${name}' was issued for another argv (granted ${shortDigest(grant.digest)}, now ${shortDigest(digest)}); a person reviews the change and grants it again`,
    };
  }
  if (grant.for !== undefined && !grant.for.includes(requester)) {
    return {
      allowed: false,
      reason: `the grant for '${name}' covers ${grant.for.join(", ")}, not ${requester}`,
    };
  }
  return { allowed: true, grant };
}

/** One runner as the list views show it: is it granted, and if not, why. */
export interface RunnerGrantRow {
  runner: string;
  digest: string;
  allowed: boolean;
  reason?: string;
  grant?: RunnerGrant;
}

/** Every runner in `worker.runners`, checked against the grants as they stand. */
export function grantRows(
  state: GrantState,
  runners: Readonly<Record<string, WorkerRunner>>,
  now: number = Date.now(),
): RunnerGrantRow[] {
  return Object.entries(runners).map(([name, runner]) => {
    const digest = runnerDigest(runner);
    const grant = state.grants.find((candidate) => candidate.runner === name);
    // Checked without a requester: a row says whether the runner is granted at
    // all, and the grant itself says whom it covers.
    const verdict = checkGrant(state, name, runner, grant?.for?.[0] ?? "", now);
    return {
      runner: name,
      digest,
      allowed: verdict.allowed,
      ...(verdict.allowed ? {} : { reason: verdict.reason }),
      ...(grant === undefined ? {} : { grant }),
    };
  });
}

/**
 * Why this process may not grant or revoke, or null when it may.
 *
 * A worker's run carries its task in the environment, and the runs Big and
 * Small deploy are exactly those runs, so a run can never issue its own
 * grant. Requiring a terminal keeps a pipe-driven process from doing it by
 * accident. Neither proves a person was there; like `--as-human`, this is
 * cooperative attribution at the place a person normally is.
 */
export function grantRefusal(env: NodeJS.ProcessEnv, interactive: boolean): string | null {
  const task = env["OGURI_TASK_ID"];
  if (task !== undefined && task !== "") {
    return `this process is the run of task ${task}; a run cannot grant or revoke runners, it may only ask with: oguri runner request`;
  }
  if (!interactive) {
    return "granting and revoking runners needs an interactive terminal, where the machine's person confirms it";
  }
  return null;
}

async function writePrivate(path: string, text: string): Promise<void> {
  const temp = `${path}.${String(process.pid)}.tmp`;
  // 0600: what a person permitted this machine to run is nothing anything
  // else on the box has any business reading or editing.
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function appendPrivate(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readLines<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const values: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a crash; the lines before it still stand.
    }
  }
  return values;
}

/** The machine's grants, requests, and audit trail, under the agent registry root. */
export class RunnerGrantStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * The store every home on this computer shares. Grants are about the
   * machine, so an agent home under `<root>/agents/<id>` reads the same file
   * the person wrote from the machine root.
   */
  static forHome(home: string): RunnerGrantStore {
    return new RunnerGrantStore(new Layout(home).agentRegistryRoot);
  }

  get grantsPath(): string {
    return join(this.root, GRANTS_FILE);
  }

  get requestsPath(): string {
    return join(this.root, RUNNER_REQUESTS_FILE);
  }

  get auditPath(): string {
    return join(this.root, RUNNER_AUDIT_FILE);
  }

  /** Read on every call: a revoke takes effect on the next check, with no restart. */
  async state(): Promise<GrantState> {
    let raw: string;
    try {
      raw = await readFile(this.grantsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { enforced: false, corrupt: false, grants: [] };
      }
      throw error;
    }
    return decodeGrants(raw);
  }

  /** Issue or replace the grant for one runner. Only a CLI command at a terminal calls this. */
  async grant(
    input: { runner: string; digest: string; for?: string[]; expiresAt?: string; note?: string },
    actor: GrantActor,
  ): Promise<RunnerGrant> {
    if (!RUNNER_NAME.test(input.runner)) throw new TypeError(`not a runner name: ${input.runner}`);
    if (!DIGEST.test(input.digest)) throw new TypeError("not a runner digest");
    if (actor.human === "") throw new TypeError("a grant must name the person who issued it");
    const state = await this.state();
    const grant: RunnerGrant = {
      id: ulid(),
      runner: input.runner,
      digest: input.digest,
      ...(input.for === undefined || input.for.length === 0 ? {} : { for: [...input.for] }),
      grantedAt: new Date().toISOString(),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      grantedBy: actor,
      ...(input.note === undefined || input.note === "" ? {} : { note: input.note }),
    };
    // One grant per runner: granting again replaces it, so a re-grant after
    // an argv change never leaves the old digest live beside the new one.
    const kept = state.grants.filter((existing) => existing.runner !== input.runner);
    await this.writeGrants([...kept, grant]);
    await this.audit({
      action: "grant",
      runner: input.runner,
      actor,
      digest: input.digest,
      detail: [
        grant.for === undefined ? "for any requester" : `for ${grant.for.join(", ")}`,
        grant.expiresAt === undefined ? "until revoked" : `until ${grant.expiresAt}`,
        ...(grant.note === undefined ? [] : [grant.note]),
      ].join("; "),
    });
    return grant;
  }

  /**
   * Withdraw a runner's grant. The file stays, so enforcement stays on and
   * the runner is refused from the next pass. Returns false when there was
   * nothing to withdraw.
   */
  async revoke(runner: string, actor: GrantActor): Promise<boolean> {
    const state = await this.state();
    const remaining = state.grants.filter((grant) => grant.runner !== runner);
    const removed = remaining.length !== state.grants.length;
    if (removed || state.corrupt) await this.writeGrants(remaining);
    await this.audit({
      action: "revoke",
      runner,
      actor,
      detail: removed ? "grant withdrawn" : "no grant was in force",
    });
    return removed;
  }

  private async writeGrants(grants: readonly RunnerGrant[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writePrivate(
      this.grantsPath,
      `${JSON.stringify({ v: FILE_VERSION, grants: [...grants] }, null, 2)}\n`,
    );
  }

  /**
   * Ask a person for a runner. Any agent may: a request grants nothing and
   * never touches `grants.json`. The same runner asked for the same task is
   * recorded once, so a worker refusing every pass does not flood the file.
   */
  async request(
    input: Omit<RunnerRequest, "id" | "at">,
  ): Promise<{ request: RunnerRequest; duplicate: boolean }> {
    if (!RUNNER_NAME.test(input.runner)) throw new TypeError(`not a runner name: ${input.runner}`);
    const reason = input.reason.trim().slice(0, MAX_REASON);
    if (reason === "") throw new TypeError("a runner request must say why the runner is needed");
    const existing = (await this.requests()).find(
      (request) =>
        request.runner === input.runner &&
        request.by === input.by &&
        (request.taskId ?? null) === (input.taskId ?? null) &&
        (input.taskId !== undefined || request.reason === reason),
    );
    if (existing !== undefined) return { request: existing, duplicate: true };
    const request: RunnerRequest = {
      id: ulid(),
      runner: input.runner,
      by: input.by,
      via: input.via,
      reason,
      at: new Date().toISOString(),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.room === undefined ? {} : { room: input.room }),
    };
    await mkdir(this.root, { recursive: true });
    await appendPrivate(this.requestsPath, request);
    await this.audit({
      action: "request",
      runner: input.runner,
      actor: { agent: input.by, via: input.via },
      detail: input.taskId === undefined ? reason : `task ${input.taskId}: ${reason}`,
    });
    return { request, duplicate: false };
  }

  /** Every request, oldest first. */
  async requests(): Promise<RunnerRequest[]> {
    return await readLines<RunnerRequest>(this.requestsPath);
  }

  /** Append one line to the audit trail. It is only ever appended to. */
  async audit(entry: Omit<AuditEntry, "at">): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendPrivate(this.auditPath, { at: new Date().toISOString(), ...entry });
  }

  /** The audit trail, oldest first. */
  async auditLog(): Promise<AuditEntry[]> {
    return await readLines<AuditEntry>(this.auditPath);
  }
}
