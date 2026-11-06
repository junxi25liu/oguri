/**
 * Publish a run's result that could not be published when the run ended.
 *
 * A run whose report (and the short fallback report) was refused used to be
 * recorded `unreported` and forgotten: the task stayed `in_progress` under this
 * agent for good. Now the record keeps the report it owes in `pendingReport`,
 * and every pass and every start retries it with a growing delay until the task
 * has heard it or no longer wants it. `unreported` is therefore only ever the
 * state of a report on its way out.
 *
 * Nothing is published twice: before each retry the task is read, and a report
 * this run already put on it (found by the `Full log: <agent>:<run dir>` line
 * every report ends with) settles the record instead.
 */

import { describeError, type TaskDetail } from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import { stopReason } from "./lifecycle.ts";
import { postInThread, relayAfterRun } from "./relay.ts";
import {
  listRuns,
  runDir,
  writeRunRecord,
  type PendingReport,
  type RunOutcome,
  type RunRecord,
} from "./runs.ts";

export const REPORT_RETRY_FIRST_MS = 30_000;
export const REPORT_RETRY_MAX_MS = 15 * 60_000;
/** Failed publications after which `oguri worker status` and the dashboard flag the record. */
export const REPORT_STUCK_ATTEMPTS = 3;

/** How long to wait after the `attempts`-th failed publication. */
export function reportDelayMs(attempts: number): number {
  return Math.min(REPORT_RETRY_MAX_MS, REPORT_RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1));
}

/** The pending report of a run whose first publication has just failed. */
export function holdReport(
  draft: Omit<PendingReport, "attempts" | "nextAt" | "lastError">,
  now: number,
  error: unknown,
): PendingReport {
  return {
    ...draft,
    attempts: 1,
    nextAt: new Date(now + reportDelayMs(1)).toISOString(),
    lastError: describeError(error),
  };
}

/** True when the record still owes a report that has failed repeatedly. */
export function reportStuck(record: RunRecord): boolean {
  return (
    record.outcome === "unreported" &&
    (record.pendingReport?.attempts ?? 0) >= REPORT_STUCK_ATTEMPTS
  );
}

export interface ReportOptions {
  backend: Backend;
  agentId: string;
  home: string;
  log: (line: string) => void;
  now?: () => number;
  /** Tasks with a run in flight here; their records are not touched. */
  exclude?: ReadonlySet<string>;
  /** Called when a released task was published, so this machine backs off it. */
  onReleased?: (taskId: string) => Promise<void>;
}

export interface Reported {
  taskId: string;
  runId?: string;
  /** `published`: the report went out now. `settled`: nothing was published. `retrying`: failed again. */
  result: "published" | "settled" | "retrying";
  outcome?: RunOutcome;
}

const OUTCOME_OF_ACTION: Record<string, RunOutcome | undefined> = {
  completed: "completed",
  progressed: "waiting",
  blocked: "blocked",
  released: "released",
};

/** True when `body` names exactly this run's log directory, not a run below it. */
function names(body: string, where: string): boolean {
  let at = body.indexOf(where);
  while (at !== -1) {
    if (body[at + where.length] !== "/") return true;
    at = body.indexOf(where, at + 1);
  }
  return false;
}

/**
 * The report for a record that predates `pendingReport`.
 *
 * Its result was not kept, so what can be said is what the record knows: that
 * the run ended, how, and where its log is. It is published as `blocked`, the
 * same verdict the fallback report gave, so a person looks at the log.
 */
function legacyPending(record: RunRecord, where: string, now: number): PendingReport {
  const ended = record.timedOut
    ? "timed out"
    : record.exitCode === undefined || record.exitCode === null
      ? "no exit code recorded"
      : `exit code ${String(record.exitCode)}`;
  return {
    action: "blocked",
    body: `Worker run ended (${ended}), but its report was never delivered${record.note === undefined ? "" : `: ${record.note}`}. Full log: ${where}`.slice(
      0,
      2_000,
    ),
    refs: [],
    needsHuman: false,
    attempts: 1,
    nextAt: new Date(now).toISOString(),
  };
}

/** Retry every pending report that is due. Never throws for one record's failure. */
export async function reconcileReports(options: ReportOptions): Promise<Reported[]> {
  const now = options.now ?? Date.now;
  const records = await listRuns(options.home, Number.POSITIVE_INFINITY);
  const reported: Reported[] = [];
  for (const record of records) {
    if (record.outcome !== "unreported") continue;
    if (options.exclude?.has(record.taskId) === true) continue;
    const where = `${options.agentId}:${runDir(options.home, record.taskId, record.runId)}`;
    const pending = record.pendingReport ?? legacyPending(record, where, now());
    if (Date.parse(pending.nextAt) > now()) continue;
    try {
      reported.push(await attempt(record, pending, where, records, options));
    } catch (error) {
      options.log(`${record.taskId} could not settle an unreported run: ${describeError(error)}`);
    }
  }
  return reported;
}

async function attempt(
  record: RunRecord,
  pending: PendingReport,
  where: string,
  records: readonly RunRecord[],
  options: ReportOptions,
): Promise<Reported> {
  const { backend, agentId, home, log } = options;
  const now = options.now ?? Date.now;
  const done = (result: Reported["result"], outcome?: RunOutcome): Reported => ({
    taskId: record.taskId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    result,
    ...(outcome === undefined ? {} : { outcome }),
  });
  const settle = async (outcome: RunOutcome, why?: string): Promise<Reported> => {
    delete record.pendingReport;
    record.outcome = outcome;
    if (why !== undefined)
      record.note = record.note === undefined ? why : `${why} (${record.note})`;
    await writeRunRecord(home, record);
    return done("settled", outcome);
  };

  // A later run of the task has its own record, and the claim this report
  // answered is gone; publishing it now would speak for the wrong claim.
  // An answer in a thread does not depend on the claim, so it is exempt.
  if (
    pending.action !== "note" &&
    records.some((other) => other.taskId === record.taskId && other.startedAt > record.startedAt)
  ) {
    log(`${record.taskId} unreported run closed; a later run of the task supersedes it`);
    return await settle("cancelled", "a later run of the task supersedes this report");
  }

  try {
    const detail = await backend.call<TaskDetail>("taskShow", {
      room: record.room,
      taskId: record.taskId,
    });

    if (pending.action === "note") {
      // The answer to a follow-up goes in the thread; the task stays as it is.
      const post = pending.post;
      if (post === undefined || detail.task.state === "cancelled") {
        log(`${record.taskId} unreported follow-up closed; nothing was published`);
        return await settle(
          post?.settleAs ?? "failed",
          "the task is cancelled; the follow-up answer was not published",
        );
      }
      const thread = await backend.call<Message[]>("read", {
        room: record.room,
        thread: post.thread,
      });
      const posted = (Array.isArray(thread) ? thread : []).some(
        (message) => message.header.from === agentId && names(message.body, where),
      );
      if (!posted) {
        await postInThread(
          backend,
          { room: record.room, thread: post.thread, inReplyTo: post.inReplyTo },
          pending.body,
        );
      }
      log(`${record.taskId} follow-up answer ${posted ? "was already posted" : "posted"} on retry`);
      return await settle(post.settleAs);
    }

    const already = detail.events.find(
      (event) => event.from === agentId && names(event.body, where),
    );
    if (already !== undefined) {
      log(`${record.taskId} report was already on the task; unreported run closed`);
      return await settle(
        OUTCOME_OF_ACTION[already.action] ?? OUTCOME_OF_ACTION[pending.action] ?? "blocked",
      );
    }
    if (detail.task.state === "completed") {
      log(`${record.taskId} unreported run closed without publishing: the task is completed`);
      // An old record has no body to resend; a follow-up on a completed task
      // that never got its answer says so rather than claiming a success.
      const lostAnswer = record.pendingReport === undefined && record.followup === true;
      return await settle(
        lostAnswer ? "failed" : "completed",
        lostAnswer
          ? "the task was already completed; the follow-up answer was never delivered"
          : "the task was already completed; the run's report was not published",
      );
    }
    const reason =
      detail.task.state === "cancelled"
        ? "the task was cancelled"
        : stopReason(detail.task, agentId);
    if (reason !== null) {
      log(`${record.taskId} unreported run closed without publishing: ${reason}`);
      return await settle("cancelled", `${reason}; the run's report was not published`);
    }

    if (detail.task.state === "blocked" || detail.task.state === "stuck") {
      // Only an active task takes a transition from the run; this one is
      // already waiting for a person, which is where a report would put it.
      log(
        `${record.taskId} unreported run closed without publishing: the task is ${detail.task.state}`,
      );
      return await settle(
        "blocked",
        `the task is already ${detail.task.state}; the run's report was not published`,
      );
    }

    const outcome = await publish(backend, record, pending);
    if (outcome === "released") await options.onReleased?.(record.taskId).catch(() => undefined);
    const relay = pending.relay;
    await settle(outcome);
    // After the record is settled: a crash here loses a chat message rather
    // than repeating it.
    if (relay !== undefined) {
      const message = relayAfterRun({
        action: outcome === "blocked" ? "blocked" : relay.action,
        ...(relay.summary === undefined ? {} : { summary: relay.summary }),
        ...(relay.pr === undefined ? {} : { pr: relay.pr }),
        ...(relay.question === undefined ? {} : { question: relay.question }),
        ...(relay.failure === undefined ? {} : { failure: relay.failure }),
      });
      if (message !== null) {
        await postInThread(
          backend,
          { room: relay.room, thread: relay.thread, inReplyTo: relay.inReplyTo },
          message.body,
          message.purpose,
        ).catch((error: unknown) =>
          log(`${record.taskId} could not post the ${message.purpose}: ${describeError(error)}`),
        );
      }
    }
    log(`${record.taskId} report published on retry ${String(pending.attempts)}; run ${outcome}`);
    return done("published", outcome);
  } catch (error) {
    const attempts = pending.attempts + 1;
    record.pendingReport = {
      ...pending,
      attempts,
      nextAt: new Date(now() + reportDelayMs(attempts)).toISOString(),
      lastError: describeError(error),
    };
    await writeRunRecord(home, record);
    log(
      attempts >= REPORT_STUCK_ATTEMPTS
        ? `${record.taskId} report still undelivered after ${String(attempts)} attempts: ${describeError(error)}`
        : `${record.taskId} report not delivered (attempt ${String(attempts)}); retrying later: ${describeError(error)}`,
    );
    return done("retrying");
  }
}

/** Publish the report; when the full one is refused, the short output-free one. */
async function publish(
  backend: Backend,
  record: RunRecord,
  pending: PendingReport,
): Promise<RunOutcome> {
  const update = async (action: string, body: string, full: boolean): Promise<void> => {
    await backend.call("taskUpdate", {
      room: record.room,
      taskId: record.taskId,
      input: {
        action,
        body,
        ...(full && pending.refs.length > 0 ? { refs: pending.refs } : {}),
        ...(full && pending.needsHuman ? { needsHuman: true } : {}),
      },
    });
  };
  try {
    await update(pending.action, pending.body, true);
    return OUTCOME_OF_ACTION[pending.action] ?? "blocked";
  } catch (first) {
    if (pending.fallbackBody === undefined) throw first;
    try {
      await update("blocked", pending.fallbackBody, false);
    } catch {
      throw first;
    }
    return "blocked";
  }
}
