/**
 * The small superagent (ADR 0031): the keeper of one machine's workers.
 *
 * A worker is one task's agent session, run by this machine's worker engine
 * in its own directory. The small superagent sits beside that engine:
 *
 * - it watches the workers this machine holds and reports upward, in the
 *   task's own thread, when one is blocked, stuck, or has gone quiet, so the
 *   big superagent and the owner see it;
 * - the owner can talk to it directly: it deploys a worker here, passes a
 *   message to one of this machine's workers, stops one, or answers.
 *
 * Everything it writes is a message in the transport repository.
 */

import {
  allowListGate,
  describeError,
  parseTaskHeader,
  resolveTier,
  runnerAvailability,
  type Agenda,
  type RunnerGate,
  type SuperagentPolicy,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { machineMention, type Message } from "@oguri/protocol";

import {
  act,
  decide,
  ensureRoom,
  FROM_SUPERAGENT_TAG,
  reply,
  SMALL_KINDS,
  SMALL_REPORT_TAG,
  TO_SMALL_TAG,
  type Conversation,
} from "./act.ts";
import {
  attemptsOf,
  batchConversation,
  batchesOf,
  thinkerOf,
  workerRooms,
  workRoom,
  type Handled,
} from "./big.ts";
import { MindHolder } from "./mind.ts";
import { langOf, words } from "./words.ts";
import type { AskModel } from "./model.ts";
import {
  MAX_ATTEMPTS,
  readSuperagentState,
  writeSuperagentState,
  type SuperagentState,
} from "./state.ts";

export interface SmallReportTask {
  room: string;
  taskId: string;
  title: string;
  state: string;
  health: string;
  quietMinutes: number;
}

export interface SmallReport {
  enabled: boolean;
  at: string;
  machine: string;
  agent: string;
  /** Workers running on this machine now. */
  running: SmallReportTask[];
  /** Workers this machine holds that are blocked, stuck, or quiet. */
  attention: SmallReportTask[];
  /** Reports written upward this pass. */
  reported: { taskId: string; reason: string }[];
  /** Tasks addressed here whose tier or runner cannot run here, and why (ADR 0034). */
  unrunnable: { taskId: string; reason: string }[];
  /** Messages from the owner handled this pass. */
  handled: { messageId: string; decision: Handled }[];
}

export interface SmallOptions {
  backend: Backend;
  agentId: string;
  machine: string;
  home: string;
  loadPolicy: () => Promise<{ superagent: SuperagentPolicy; worker: WorkerPolicy }>;
  /** Tasks this machine's worker engine has in flight. */
  running?: () => ReadonlySet<string>;
  ask?: AskModel;
  /** Which runners may run here beyond the allow-list (ADR 0034); the worker uses the same. */
  gate?: RunnerGate;
  now?: () => number;
  log?: (line: string) => void;
}

const MAX_REQUESTS_PER_PASS = 3;

/** What a small superagent writes when one of its workers needs a look. Short and factual. */
export function attentionNote(task: SmallReportTask, machine: string): string {
  if (task.health === "blocked")
    return `Small superagent on ${machine}: this worker is blocked and waiting.`;
  if (task.health === "stuck") return `Small superagent on ${machine}: this worker is stuck.`;
  return `Small superagent on ${machine}: no update from this worker for ${String(task.quietMinutes)} minutes.`;
}

/**
 * Why this machine cannot run a task on the runner its header asks for, or
 * undefined when it can (ADR 0034).
 *
 * The same check the worker makes before it claims, from the same core
 * functions, so the small superagent can say why a task addressed here is not
 * starting instead of leaving it to wait in silence. It never picks another
 * runner: the requester chose that tier, and a swap would be invisible.
 */
export function tierProblem(
  definition: string,
  worker: Pick<WorkerPolicy, "runners" | "tiers">,
  gate: RunnerGate = allowListGate,
): string | undefined {
  const header = parseTaskHeader(definition);
  if (header.refusedTier !== undefined) return header.refusedTier;
  if (header.tier !== undefined) {
    const resolved = resolveTier(
      worker,
      {
        tier: header.tier,
        ...(header.runner === undefined ? {} : { runner: header.runner }),
      },
      gate,
    );
    return "error" in resolved ? resolved.error : undefined;
  }
  if (header.runner === undefined) return undefined;
  const available = runnerAvailability(worker, header.runner, gate);
  return available.ok ? undefined : available.reason;
}

/** The note for a task whose tier cannot run here. */
export function tierNote(machine: string, problem: string): string {
  return `Small superagent on ${machine}: this task will not run here: ${problem}. It was not moved to another runner.`;
}

/** A message the owner wrote to this small superagent. */
export function isSmallRequest(
  message: Message,
  self: string,
  state: Pick<SuperagentState, "handled" | "since">,
): boolean {
  const tags = message.header.tags;
  return (
    tags.includes(TO_SMALL_TAG) &&
    message.header.mentions.includes(self) &&
    !tags.includes(FROM_SUPERAGENT_TAG) &&
    !state.handled.includes(message.header.id) &&
    Date.parse(message.header.ts) >= Date.parse(state.since)
  );
}

export class SmallSuperagent {
  private readonly options: SmallOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private last: SmallReport | undefined;
  private readonly minds: MindHolder;

  constructor(options: SmallOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.minds = new MindHolder({
      home: options.home,
      name: "small",
      ...(options.ask === undefined ? {} : { ask: options.ask }),
      log: this.log,
    });
  }

  /** End the standing session's process, if it keeps one. Its id stays for the next start. */
  async close(): Promise<void> {
    await this.minds.close();
  }

  /** The latest report. */
  report(): SmallReport | undefined {
    return this.last;
  }

  async pass(signal?: AbortSignal): Promise<SmallReport> {
    const { superagent, worker } = await this.options.loadPolicy();
    const policy = superagent.small;
    const now = this.now();
    const report: SmallReport = {
      enabled: policy.enabled,
      at: new Date(now).toISOString(),
      machine: this.options.machine,
      agent: this.options.agentId,
      running: [],
      attention: [],
      reported: [],
      unrunnable: [],
      handled: [],
    };
    if (!policy.enabled) {
      this.last = report;
      return report;
    }
    const state = await readSuperagentState(this.options.home, "small", now);
    try {
      await this.join(superagent);
      await this.watch(policy, worker, state, report);
      if (policy.talk) await this.talk(superagent, worker, state, report, signal);
    } finally {
      await writeSuperagentState(this.options.home, "small", state);
    }
    this.last = report;
    return report;
  }

  /**
   * Join the rooms this machine's workers and conversations are in. The work
   * room is joined whether or not the owner may talk to this machine: its
   * workers are deployed there, and a worker only sees rooms it is in.
   */
  async join(superagent: SuperagentPolicy): Promise<void> {
    const { backend } = this.options;
    const work = workRoom(superagent);
    await ensureRoom(backend, work, "Workers deployed by the superagents.");
    // The conversation room too: to talk, and because workers deployed before
    // the work room had its own name are there.
    if (superagent.big.room !== work) {
      await ensureRoom(backend, superagent.big.room, "Talk to the superagents here.");
    }
  }

  /** Report the workers this machine holds that need a look. */
  private async watch(
    policy: SuperagentPolicy["small"],
    worker: WorkerPolicy,
    state: SuperagentState,
    report: SmallReport,
  ): Promise<void> {
    const { backend, agentId, machine } = this.options;
    const now = this.now();
    const agenda = await backend.call<Agenda>("agenda", { includeUnclaimed: false });
    const running = this.options.running?.() ?? new Set<string>();
    const held = new Set<string>();
    const note = async (
      room: string,
      thread: string,
      inReplyTo: string,
      body: string,
      tag: string,
    ): Promise<void> => {
      await backend.call("send", {
        room,
        input: {
          body,
          kind: "msg",
          needs: "none",
          thread,
          inReplyTo,
          tags: [SMALL_REPORT_TAG, tag],
        },
      });
    };
    for (const entry of agenda.entries) {
      const status = entry.status;
      // A task offered here that has not started: check, before the worker
      // would, that the runner it asks for can run here (ADR 0034).
      if (entry.relation === "offered" && status.task.state === "open") {
        held.add(status.task.id);
        const problem = tierProblem(status.definition, worker, this.options.gate);
        if (problem === undefined) continue;
        report.unrunnable.push({ taskId: status.task.id, reason: problem });
        const key = `${status.task.id}:tier`;
        if (state.noted[key] !== undefined) continue;
        try {
          await note(
            entry.room,
            status.thread,
            status.currentMessageId,
            tierNote(machine, problem),
            "superagent-tier",
          );
          state.noted[key] = now;
          report.reported.push({ taskId: status.task.id, reason: "tier" });
        } catch (error) {
          this.log(`could not report ${status.task.id}: ${describeError(error)}`);
        }
        continue;
      }
      if (status.task.assignee !== agentId) continue;
      if (status.task.state === "completed" || status.task.state === "cancelled") continue;
      held.add(status.task.id);
      const quietMinutes = Math.floor((now - Date.parse(status.updatedAt)) / 60_000);
      const row: SmallReportTask = {
        room: entry.room,
        taskId: status.task.id,
        title: status.task.title,
        state: status.task.state,
        health: status.health,
        quietMinutes,
      };
      if (running.has(status.task.id)) report.running.push(row);
      // Quiet means a worker that is running and says nothing. A task held but
      // not running is waiting: for a run slot, or, as a plan's parent, for its
      // steps; one that is truly stuck turns stuck by itself.
      const quiet = running.has(status.task.id) && quietMinutes >= policy.quietMinutes;
      if (status.health !== "blocked" && status.health !== "stuck" && !quiet) continue;
      report.attention.push(row);
      // Blocked and stuck are reported once; quiet again every `reportEveryMinutes`.
      const reason =
        status.health === "blocked" || status.health === "stuck" ? status.health : "quiet";
      const key = `${status.task.id}:${reason}`;
      const lastAt = state.noted[key] ?? 0;
      const due =
        reason === "quiet" ? now - lastAt >= policy.reportEveryMinutes * 60_000 : lastAt === 0;
      if (!due) continue;
      try {
        await note(
          entry.room,
          status.thread,
          status.currentMessageId,
          attentionNote(row, machine),
          `superagent-${reason}`,
        );
        state.noted[key] = now;
        report.reported.push({ taskId: status.task.id, reason });
      } catch (error) {
        this.log(`could not report ${status.task.id}: ${describeError(error)}`);
      }
    }
    for (const key of Object.keys(state.noted)) {
      if (!held.has(key.split(":")[0] ?? "")) delete state.noted[key];
    }
  }

  /** Answer the owner when they talk to this machine directly. */
  private async talk(
    superagent: SuperagentPolicy,
    worker: WorkerPolicy,
    state: SuperagentState,
    report: SmallReport,
    signal?: AbortSignal,
  ): Promise<void> {
    const { backend, agentId, machine } = this.options;
    const room = superagent.big.room;
    const work = workRoom(superagent);
    const messages = await backend.call<Message[]>("read", { room });
    const mind = await this.minds.get(thinkerOf(worker, superagent.small.runner));
    const batches = batchesOf(messages.filter((m) => isSmallRequest(m, agentId, state))).slice(
      0,
      MAX_REQUESTS_PER_PASS,
    );
    for (const batch of batches) {
      if (signal?.aborted === true) break;
      const message = batch.at(-1) as Message;
      const key = (batch[0] as Message).header.id;
      const conversation: Conversation = { ...batchConversation(batch, messages), room };
      const decided = await decide(conversation, {
        backend,
        worker,
        role: "small",
        kinds: SMALL_KINDS,
        self: agentId,
        machine,
        timeoutSeconds: superagent.big.timeoutSeconds,
        rooms: workerRooms(superagent),
        defaultRoom: work,
        only: { agents: [agentId], machine },
        defaultTarget: machineMention(machine),
        maxWorkers: superagent.small.maxWorkers,
        now: this.now(),
        ...(superagent.small.runner === undefined ? {} : { runner: superagent.small.runner }),
        ...(this.options.ask === undefined ? {} : { ask: this.options.ask }),
        ...(mind === undefined ? {} : { mind }),
        ...(this.options.gate === undefined ? {} : { gate: this.options.gate }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (decided.decision === null && decided.retry === true) {
        // The model did not answer: ask again on a later pass, twice, then give up.
        const attempts = (state.attempts[key] ?? 0) + 1;
        if (attempts < MAX_ATTEMPTS) {
          state.attempts[key] = attempts;
          report.handled.push({ messageId: message.header.id, decision: "deferred" });
          continue;
        }
      }
      delete state.attempts[key];
      for (const m of batch) state.handled.push(m.header.id);
      if (decided.decision === null) {
        await reply(
          backend,
          conversation,
          agentId,
          words(langOf(conversation.text)).undecidedOn(machine, decided.why ?? "unknown"),
          this.log,
        );
        report.handled.push({ messageId: message.header.id, decision: "undecided" });
        continue;
      }
      try {
        const acted = await act(
          // A worker this small superagent deploys runs here unless the decision says otherwise.
          {
            backend,
            agentId,
            policy: superagent,
            defaultTarget: machineMention(machine),
            ...attemptsOf(worker),
            log: this.log,
          },
          conversation,
          decided.decision,
          workerRooms(superagent),
        );
        if (acted.reply !== "") await reply(backend, conversation, agentId, acted.reply, this.log);
      } catch (error) {
        await reply(
          backend,
          conversation,
          agentId,
          words(langOf(conversation.text)).failed(decided.decision.kind, describeError(error)),
          this.log,
        );
      }
      report.handled.push({ messageId: message.header.id, decision: decided.decision.kind });
    }
  }
}
