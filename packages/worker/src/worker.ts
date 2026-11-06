/**
 * The worker: turn tasks addressed here into supervised runs (ADR 0026).
 *
 * One pass reads the agenda, picks ready tasks offered to this agent or machine
 * or matching its capabilities, and for each one approves (only for trusted
 * requesters), claims, runs, and reports. It also rolls up parents this agent
 * holds once their subtasks are done (ADR 0027), and runs again a task it ran
 * when a person follows up in its thread (ADR 0030). It talks to oguri only through
 * `Backend`, so git stays the daemon's business and a hung run cannot stall
 * delivery.
 */

import { hostname } from "node:os";

import {
  RunnerGrantStore,
  describeError,
  type Agenda,
  type RunnerGate,
  type TaskDetail,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { RunBudget } from "./budget.ts";
import { publishCapabilities } from "./capabilities.ts";
import { claimCandidate, retakeTask } from "./claim.ts";
import { executeRun, type RunHost } from "./execute.ts";
import { findFollowups, type Followup } from "./followup.ts";
import { gateCandidates, requestMissingRunners, type GateContext } from "./grants.ts";
import { HomeSlots, type SlotLease } from "./home-slots.ts";
import { abandonAction, stopReason } from "./lifecycle.ts";
import { reconcileRuns, type Recovered } from "./recover.ts";
import { reconcileReports, type Reported } from "./report.ts";
import { RetryBackoff } from "./retry.ts";
import { rollupAssigned, type RolledUp } from "./rollup.ts";
import { killGroup, runExecutor, type Executor } from "./runner.ts";
import { listRuns, newRunId, taskRuns, writeRunRecord, type RunRecord } from "./runs.ts";
import { type Candidate, type Skipped, selectCandidates } from "./select.ts";
import { runnerEffort, runnerModel } from "./session.ts";
import type { McpServer } from "./tools.ts";

export { expandHome } from "./workspace.ts";

export interface WorkerOptions {
  backend: Backend;
  agentId: string;
  /** This agent's machine id, named in `artifact:` refs. Defaults to the hostname. */
  machineId?: string;
  /** This agent's oguri home. Run logs go under `<home>/runs/`. */
  home: string;
  /** Read before every pass, so turning the worker off needs no restart. */
  loadPolicy: () => Promise<WorkerPolicy>;
  log?: (line: string) => void;
  executor?: Executor;
  now?: () => number;
  /** How often a long run posts a progress update. */
  heartbeatMs?: number;
  /** How often an in-flight run checks that its task is still its own. */
  checkIntervalMs?: number;
  /** How a run starts oguri's MCP server, so `claude` and `codex` runs get oguri's tools (ADR 0032). */
  oguriMcp?: McpServer;
  /** How often a live session looks for a person's new messages. */
  liveIntervalMs?: number;
  /**
   * Which allow-listed runners may run here (ADR 0034). Defaults to the
   * allow-list alone; a grant check plugs in here and can only narrow it.
   */
  gate?: RunnerGate;
}

export interface PassReport {
  enabled: boolean;
  started: string[];
  skipped: { taskId: string; reason: string }[];
  /** Tasks addressed here that are not ready: a dependency is pending or no attempt is left. */
  waiting?: Skipped[];
  /** Runs a previous worker left behind, settled before this pass started anything. */
  recovered?: Recovered[];
  /** Undelivered run reports retried this pass, with what became of each. */
  reported?: Reported[];
  /** Parents this agent holds that were completed or noted because of their subtasks. */
  rolledUp?: RolledUp[];
  /** Set when the pass stopped early because no run could start. */
  limited?: string;
  /** Tasks in `started` that run because a person followed up in their thread. */
  followups?: string[];
}

/** One run this process is supervising. */
interface ActiveRun {
  record: RunRecord;
  controller: AbortController;
  /** Stop the run if its task is no longer this agent's to do. */
  check: () => Promise<void>;
  done: Promise<void>;
}

const HOUR_MS = 60 * 60_000;

export class Worker {
  private readonly options: WorkerOptions;
  private readonly executor: Executor;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly budget: RunBudget;
  /** The same limit counted across every worker process on this home. */
  private readonly slots: HomeSlots;
  private readonly backoff: RetryBackoff;
  /** The machine's runner grants, read afresh on every pass. */
  private readonly grants: RunnerGrantStore;
  private readonly inFlight = new Map<string, ActiveRun>();
  /** Tasks already reported as waiting, so a pass every 30s does not repeat itself. */
  private readonly noted = new Set<string>();
  private policy: WorkerPolicy | undefined;
  private recovered = false;
  /** Reports retried by `recover`, handed to the pass that follows it. */
  private startupReports: Reported[] = [];
  private capabilitiesPublished = false;
  private abandoning = false;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.executor = options.executor ?? runExecutor;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.budget = new RunBudget(
      () => ({
        concurrency: this.policy?.concurrency ?? 1,
        maxPerHour: this.policy?.maxPerHour ?? 1,
      }),
      this.now,
    );
    this.backoff = new RetryBackoff(options.home, this.now);
    this.slots = new HomeSlots(options.home);
    this.grants = RunnerGrantStore.forHome(options.home);
  }

  get running(): number {
    return this.inFlight.size;
  }

  /** The tasks whose workers run here now: one agent session each. */
  runningTasks(): ReadonlySet<string> {
    return new Set(this.inFlight.keys());
  }

  get startedThisHour(): number {
    return this.budget.startedThisHour();
  }

  /** Wait for every run this worker started. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((run) => run.done));
    }
  }

  /**
   * Settle what an earlier worker left behind, and count its runs against the hour.
   *
   * `pass` calls this once, before it starts anything. It is public so a caller
   * can do it at start-up and report the result.
   */
  async recover(policy: WorkerPolicy): Promise<Recovered[]> {
    if (this.recovered) return [];
    const { backend, agentId, home } = this.options;
    const recovered = await reconcileRuns({
      backend,
      agentId,
      home,
      onAbandon: policy.onAbandon,
      log: this.log,
      now: this.now,
    });
    const cutoff = this.now() - HOUR_MS;
    const earlier = await listRuns(home, Number.POSITIVE_INFINITY);
    this.budget.seed(
      earlier
        .map((run) => Date.parse(run.startedAt))
        .filter((at) => Number.isFinite(at) && at > cutoff),
    );
    this.recovered = true;
    this.startupReports = await this.retryReports(policy);
    return recovered;
  }

  /**
   * Publish results an earlier run could not (see `report.ts`), once each is due.
   *
   * Runs at start-up and at the head of every pass. A failure is logged by the
   * retry itself and never stops the pass.
   */
  private async retryReports(policy: WorkerPolicy): Promise<Reported[]> {
    const { backend, agentId, home } = this.options;
    try {
      return await reconcileReports({
        backend,
        agentId,
        home,
        log: this.log,
        now: this.now,
        exclude: new Set(this.inFlight.keys()),
        onReleased: async (taskId) => await this.backoff.set(taskId, policy.retry.backoffMinutes),
      });
    } catch (error) {
      this.log(`could not retry undelivered reports: ${describeError(error)}`);
      return [];
    }
  }

  /**
   * Stop every in-flight run now and mark its record `abandoned`.
   *
   * For a forced stop. Nothing is published: the next start reconciles the
   * records and settles their tasks, by the same path a crash takes.
   */
  async abandon(): Promise<void> {
    this.abandoning = true;
    for (const run of this.inFlight.values()) {
      run.controller.abort("the worker is stopping");
      if (run.record.pid !== undefined) killGroup(run.record.pid, "SIGKILL");
      run.record.outcome = "abandoned";
      run.record.finishedAt = new Date(this.now()).toISOString();
      run.record.note = "the worker was stopped while the run was in flight";
      await writeRunRecord(this.options.home, run.record);
    }
  }

  /** One pass. Starts runs and returns without waiting for them; see `idle`. */
  async pass(): Promise<PassReport> {
    const policy = await this.options.loadPolicy();
    this.policy = policy;
    const report: PassReport = { enabled: policy.enabled, started: [], skipped: [] };
    if (!policy.enabled) return report;

    await this.options.backend.call("sync").catch((error: unknown) => {
      this.log(`sync failed, using what is already local: ${describeError(error)}`);
    });
    if (!this.recovered) {
      const recovered = await this.recover(policy);
      if (recovered.length > 0) report.recovered = recovered;
    }
    const reported = [...this.startupReports.splice(0), ...(await this.retryReports(policy))];
    if (reported.length > 0) report.reported = reported;
    await this.publishCapabilities(policy);
    await Promise.all([...this.inFlight.values()].map(async (run) => await run.check()));

    // A task released by recovery is not taken back in the same pass, so a
    // crash does not turn straight into a retry on the machine that crashed.
    const exclude = new Set([
      ...this.inFlight.keys(),
      ...(report.recovered ?? []).map((r) => r.taskId),
      ...reported.map((r) => r.taskId),
    ]);
    // Asking with the worker's own capabilities is what makes capability work
    // `capable` and decides `ready` for every task that names requirements.
    const agenda = await this.options.backend.call<Agenda>("agenda", {
      includeUnclaimed: false,
      ...(policy.capabilities.length === 0 ? {} : { includeCapable: policy.capabilities }),
    });
    const {
      candidates: selected,
      skipped,
      notices,
      waiting,
    } = selectCandidates(
      agenda,
      policy,
      exclude,
      ...(this.options.gate === undefined ? [] : [this.options.gate]),
    );
    // Runner grants (runner-grants.ts): a no-op until a person issues one.
    const gate = this.gateContext(policy);
    await requestMissingRunners(gate, agenda, skipped);
    const { allowed: candidates, refused } = await gateCandidates(gate, selected);
    skipped.push(...refused);
    for (const skip of skipped) this.note(skip.taskId, `skipping ${skip.taskId}: ${skip.reason}`);
    // A task that runs anyway, with an `effort:` hint this machine refuses.
    for (const notice of notices)
      this.note(`effort:${notice.taskId}`, `${notice.taskId} ${notice.reason}`);
    report.skipped.push(...skipped.map(({ taskId, reason }) => ({ taskId, reason })));
    for (const wait of waiting) {
      this.note(`waiting:${wait.taskId}`, `${wait.taskId} not ready: ${wait.reason}`);
    }
    if (waiting.length > 0) report.waiting = waiting;

    const rolledUp = await rollupAssigned(this.options.backend, this.options.agentId, agenda, {
      exclude: new Set(this.inFlight.keys()),
      noted: this.noted,
      log: this.log,
    });
    if (rolledUp.length > 0) report.rolledUp = rolledUp;

    for (const candidate of candidates) {
      if (this.abandoning) break;
      const notBefore = await this.backoff.until(candidate.taskId);
      if (notBefore !== null) {
        const reason = `failed here earlier; not retried on this machine before ${new Date(notBefore).toISOString()}`;
        this.note(
          `backoff:${candidate.taskId}:${String(notBefore)}`,
          `${candidate.taskId} ${reason}`,
        );
        report.skipped.push({ taskId: candidate.taskId, reason });
        continue;
      }
      const blocker = this.budget.blocker();
      if (blocker !== null) {
        report.limited = blocker;
        this.note(`limit:${blocker}`, `waiting: ${blocker}`);
        break;
      }
      const reserved = await this.slots.reserve({ concurrency: policy.concurrency }, false);
      if ("blocker" in reserved) {
        report.limited = reserved.blocker;
        this.note(`limit:${reserved.blocker}`, `waiting: ${reserved.blocker}`);
        break;
      }
      const lease = reserved.lease;
      let claimed: Awaited<ReturnType<typeof claimCandidate>>;
      try {
        claimed = await claimCandidate(
          this.options.backend,
          this.options.agentId,
          candidate,
          policy,
        );
      } catch (error) {
        await lease.release();
        throw error;
      }
      if (!claimed.claimed) {
        await lease.release();
        const line = `${candidate.taskId} ${claimed.reason}`;
        if (claimed.quiet) this.note(claimed.key, line);
        else this.log(line);
        report.skipped.push({ taskId: candidate.taskId, reason: claimed.reason });
        continue;
      }
      this.noted.delete(candidate.taskId);
      this.budget.start();
      report.started.push(candidate.taskId);
      // A task released or reopened back to this machine has run here before.
      const [latest] = await taskRuns(this.options.home, candidate.taskId);
      this.begin(candidate, policy, claimed.attempt, {
        ranBefore: latest !== undefined,
        lease,
        ...(latest === undefined ? {} : { since: latest.followupSince ?? latest.startedAt }),
      });
    }
    if (!this.abandoning) await this.followups(policy, agenda, exclude, report);
    return report;
  }

  /**
   * Add `worker.capabilities` to this agent's profile, once per process.
   *
   * A failure is logged and tried again next pass. It never stops the pass:
   * claims carry the capabilities themselves, so the work still routes.
   */
  private async publishCapabilities(policy: WorkerPolicy): Promise<void> {
    if (this.capabilitiesPublished || policy.capabilities.length === 0) return;
    try {
      const { added } = await publishCapabilities(this.options.backend, policy.capabilities);
      this.capabilitiesPublished = true;
      if (added.length > 0) this.log(`profile now declares capabilities: ${added.join(", ")}`);
    } catch (error) {
      this.note(
        "capabilities",
        `could not add worker.capabilities to the profile: ${describeError(error)}`,
      );
    }
  }

  /** Register a run before it does anything, so `abandon` can always find it. */
  private begin(
    candidate: Candidate,
    policy: WorkerPolicy,
    attempt: number,
    options: {
      /** This agent ran the task before on this machine. */
      ranBefore: boolean;
      /** The home-wide slot this run holds until it ends. */
      lease: SlotLease;
      /**
       * Where the follow-up window starts, carried over from the task's last
       * run, so a person's message that arrived before this run is not lost.
       */
      since?: string;
      followup?: Followup;
    },
  ): void {
    const { ranBefore, followup } = options;
    const started = this.now();
    const askedModel = runnerModel(candidate.argv);
    const askedEffort = runnerEffort(candidate.argv);
    const record: RunRecord = {
      taskId: candidate.taskId,
      runId: newRunId(started),
      room: candidate.room,
      title: candidate.title,
      runner: candidate.runner,
      // The runner's own argv is the only place the model and effort are
      // known before the run starts. Both are recorded as requests; the run's
      // output may separately report which model answered, and cannot make an
      // unrequested model appear here.
      ...(askedModel === undefined ? {} : { modelRequested: askedModel }),
      ...(askedEffort === undefined ? {} : { effortRequested: askedEffort }),
      ...(askedEffort === undefined || candidate.effortSource === undefined
        ? {}
        : { effortSource: candidate.effortSource }),
      ...(candidate.tier === undefined ? {} : { tier: candidate.tier }),
      ...(candidate.tierReason === undefined ? {} : { tierReason: candidate.tierReason }),
      startedAt: new Date(started).toISOString(),
      outcome: "running",
      workerPid: process.pid,
      attempt,
      ...(candidate.thread === undefined ? {} : { thread: candidate.thread }),
      ...(candidate.origin === undefined ? {} : { origin: candidate.origin.source }),
      // The session carries over until this run reports its own.
      ...(followup?.previous.sessionId === undefined
        ? {}
        : { sessionId: followup.previous.sessionId }),
      ...(followup === undefined ? {} : { followup: true }),
      ...(options.since === undefined ? {} : { followupSince: options.since }),
    };
    const controller = new AbortController();
    let checking = false;
    // A follow-up answered on a task that stays completed holds no claim to lose.
    const holdsTask = followup?.retake !== "reply";
    const check = async (): Promise<void> => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const detail = await this.options.backend.call<TaskDetail>("taskShow", {
          room: candidate.room,
          taskId: candidate.taskId,
        });
        const reason = holdsTask
          ? stopReason(detail.task, this.options.agentId)
          : detail.task.state === "completed"
            ? null
            : `the task is now ${detail.task.state}`;
        if (reason !== null && !controller.signal.aborted) {
          this.log(`${candidate.taskId} stopping the run: ${reason}`);
          controller.abort(reason);
        }
      } catch {
        // A failed read says nothing about the task; the next check tries again.
      } finally {
        checking = false;
      }
    };
    const run: ActiveRun = { record, controller, check, done: Promise.resolve() };
    const isFollowup = followup !== undefined;
    run.done = executeRun(this.host(), {
      candidate,
      policy,
      record,
      controller,
      check,
      ranBefore,
      ...(followup === undefined ? {} : { followup }),
    })
      .catch(async (error: unknown) => {
        this.log(`run ${candidate.taskId} crashed: ${describeError(error)}`);
        await this.settleUnstarted(candidate, policy, record, error);
      })
      .finally(async () => {
        this.budget.finish(isFollowup);
        this.inFlight.delete(candidate.taskId);
        // `done` settles after this, so `idle` returns once the slot is free too.
        await options.lease.release().catch(() => undefined);
      });
    this.inFlight.set(candidate.taskId, run);
  }

  /**
   * Hand back a claim whose run never wrote a record.
   *
   * A run's first act is to write its `run.json`. Before that write succeeds
   * there is no local evidence of the claim at all, and every recovery path
   * reads records — so a run that dies there leaves the task `claimed` under
   * this agent forever, reported in flight by every surface, and no restart
   * or repaired directory settles it. The claim is the thing to settle, and
   * it is settled exactly like an abandoned run: the same `abandonAction`
   * decides release or block from `worker.onAbandon`, and a release takes the
   * usual backoff so this machine does not immediately fail it again.
   */
  private async settleUnstarted(
    candidate: Candidate,
    policy: WorkerPolicy,
    record: RunRecord,
    error: unknown,
  ): Promise<void> {
    const { backend, agentId, home } = this.options;
    try {
      // The run reached its record after all: its own failure path reported
      // the task, or the next start's recovery will. Settling here too would
      // publish a second transition for one claim.
      const settled = (await taskRuns(home, candidate.taskId)).some(
        (run) => run.runId === record.runId,
      );
      if (settled) return;
      const detail = await backend.call<TaskDetail>("taskShow", {
        room: candidate.room,
        taskId: candidate.taskId,
      });
      const action = abandonAction(detail.task, agentId, policy.onAbandon);
      if (action === null) return;
      const reason = describeError(error);
      const body =
        action === "released"
          ? `Released by worker ${agentId}: its run could not start on this machine (${reason}). Another machine may take the task.`
          : `Blocked by worker ${agentId}: its run could not start on this machine (${reason}). A person should look before it is run again.`;
      await backend.call("taskUpdate", {
        room: candidate.room,
        taskId: candidate.taskId,
        input: { action, body },
      });
      if (action === "released") {
        await this.backoff.set(candidate.taskId, policy.retry.backoffMinutes);
      }
      this.log(`${candidate.taskId} ${action}: the run could not start`);
    } catch (settleError) {
      // Nothing else can be done from here; the log is the only trace.
      this.log(
        `${candidate.taskId} could not settle the claim after a run that never started: ${describeError(settleError)}`,
      );
    }
  }

  private host(): RunHost {
    const { backend, agentId, home } = this.options;
    return {
      backend,
      agentId,
      home,
      machine: this.options.machineId ?? hostname(),
      executor: this.executor,
      backoff: this.backoff,
      log: this.log,
      now: this.now,
      abandoning: () => this.abandoning,
      ...(this.options.heartbeatMs === undefined ? {} : { heartbeatMs: this.options.heartbeatMs }),
      ...(this.options.checkIntervalMs === undefined
        ? {}
        : { checkIntervalMs: this.options.checkIntervalMs }),
      ...(this.options.oguriMcp === undefined ? {} : { oguriMcp: this.options.oguriMcp }),
      ...(this.options.liveIntervalMs === undefined
        ? {}
        : { liveIntervalMs: this.options.liveIntervalMs }),
      ...(this.options.gate === undefined ? {} : { gate: this.options.gate }),
    };
  }

  /**
   * Run a person's follow-ups on tasks this worker ran (ADR 0030 §5).
   *
   * After new work, so the reserved slot is what lets a follow-up start when
   * new work filled the others. The hourly cap still applies.
   */
  private async followups(
    policy: WorkerPolicy,
    agenda: Agenda,
    exclude: ReadonlySet<string>,
    report: PassReport,
  ): Promise<void> {
    const { jobs, skipped } = await findFollowups({
      backend: this.options.backend,
      agentId: this.options.agentId,
      home: this.options.home,
      policy,
      active: new Set(agenda.entries.map((entry) => entry.status.task.id)),
      exclude: new Set([...exclude, ...this.inFlight.keys()]),
      now: this.now(),
      note: (key, line) => this.note(key, line),
      ...(this.options.gate === undefined ? {} : { gate: this.options.gate }),
    });
    report.skipped.push(...skipped.map(({ taskId, reason }) => ({ taskId, reason })));
    // A revoked grant refuses a follow-up too: it starts the same runner.
    const gated = await gateCandidates(
      this.gateContext(policy),
      jobs.map((job) => job.candidate),
    );
    for (const refusal of gated.refused) {
      this.note(
        `skip:${refusal.taskId}`,
        `skipping follow-up ${refusal.taskId}: ${refusal.reason}`,
      );
      report.skipped.push({ taskId: refusal.taskId, reason: refusal.reason });
    }
    for (const { candidate, followup } of jobs) {
      if (this.abandoning) break;
      if (!gated.allowed.includes(candidate)) continue;
      const blocker = this.budget.blocker(true);
      if (blocker !== null) {
        report.limited = blocker;
        this.note(`limit:${blocker}`, `follow-up waiting: ${blocker}`);
        break;
      }
      const reserved = await this.slots.reserve({ concurrency: policy.concurrency }, true);
      if ("blocker" in reserved) {
        report.limited = reserved.blocker;
        this.note(`limit:${reserved.blocker}`, `follow-up waiting: ${reserved.blocker}`);
        break;
      }
      const lease = reserved.lease;
      let taken: Awaited<ReturnType<typeof retakeTask>>;
      try {
        taken = await retakeTask(
          this.options.backend,
          this.options.agentId,
          candidate,
          followup.retake,
          policy,
        );
      } catch (error) {
        await lease.release();
        throw error;
      }
      if (!taken.claimed) {
        await lease.release();
        const line = `${candidate.taskId} follow-up ${taken.reason}`;
        if (taken.quiet) this.note(taken.key, line);
        else this.log(line);
        report.skipped.push({ taskId: candidate.taskId, reason: taken.reason });
        continue;
      }
      this.budget.start(true);
      report.started.push(candidate.taskId);
      (report.followups ??= []).push(candidate.taskId);
      this.begin(candidate, policy, taken.attempt, {
        ranBefore: true,
        lease,
        since: followup.previous.followupSince ?? followup.previous.startedAt,
        followup,
      });
    }
  }

  private gateContext(policy: WorkerPolicy): GateContext {
    return {
      store: this.grants,
      backend: this.options.backend,
      agentId: this.options.agentId,
      policy,
      note: (key, line) => this.note(key, line),
    };
  }

  private note(key: string, line: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.log(line);
  }
}
