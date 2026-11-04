/**
 * One run, from its workspace to its report.
 *
 * The worker decides what runs and when; this decides how a run goes once it
 * has a slot and a claim. A follow-up goes through the same path as a new
 * task, so the rules for timeouts, cancellation, `result.json`, retries, and
 * the secret scanner are the same for both.
 */

import { describeError, type WorkerPolicy } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import type { Followup } from "./followup.ts";
import { planLaunch } from "./launch.ts";
import { buildReport, fallbackReport } from "./outcome.ts";
import { acknowledge, postInThread, relayAfterRun, tailWords } from "./relay.ts";
import { readResult, resultPath, type ResultRead } from "./result.ts";
import type { RetryBackoff } from "./retry.ts";
import { openChildCount } from "./rollup.ts";
import type { Executor, RunResult } from "./runner.ts";
import { addConsumed, readConsumed, runDir, writeRunRecord, type RunRecord } from "./runs.ts";
import type { Candidate } from "./select.ts";
import { readSession, sessionFile } from "./session.ts";
import { failureReason, formatDuration, summarise, succeeded } from "./summary.ts";
import {
  agentFlavor,
  liveText,
  newMessagesFor,
  REPLAY_FLAG,
  withOguriTools,
  withReplay,
  type McpServer,
} from "./tools.ts";
import { expandHome, prepareWorkspace, type Workspace } from "./workspace.ts";

const DEFAULT_HEARTBEAT_MS = 15 * 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_LIVE_INTERVAL_MS = 10_000;

/** What a run needs from the worker supervising it. */
export interface RunHost {
  backend: Backend;
  agentId: string;
  home: string;
  machine: string;
  executor: Executor;
  backoff: RetryBackoff;
  log: (line: string) => void;
  now: () => number;
  /** True once a forced stop has written every in-flight record. */
  abandoning: () => boolean;
  heartbeatMs?: number;
  checkIntervalMs?: number;
  /** How a run starts oguri's MCP server; without it, runs get no oguri tools (ADR 0032). */
  oguriMcp?: McpServer;
  /** How often a live session looks for a person's new messages. */
  liveIntervalMs?: number;
}

export interface RunJob {
  candidate: Candidate;
  policy: WorkerPolicy;
  record: RunRecord;
  controller: AbortController;
  /** Stop the run if its task is no longer this agent's to do. */
  check: () => Promise<void>;
  /** Set for a person's follow-up on a task this worker ran. */
  followup?: Followup;
  /** This agent ran the task before on this machine. */
  ranBefore: boolean;
}

/** The answer a person reads in the chat: the summary, else the session's text, else the output's end. */
function answerFor(read: ResultRead, result: RunResult): { summary: string; pr?: string } {
  if (read.kind === "valid") {
    return {
      summary: read.result.summary,
      ...(read.result.pr === undefined ? {} : { pr: read.result.pr }),
    };
  }
  return { summary: tailWords(result.stdoutTail) };
}

export async function executeRun(host: RunHost, job: RunJob): Promise<void> {
  const { backend, home, agentId } = host;
  const { candidate, policy, record, controller, followup } = job;
  const logDir = runDir(home, candidate.taskId, record.runId);
  const resultFile = resultPath(logDir);
  const where = `${agentId}:${logDir}`;
  const timeoutMinutes = policy.timeoutMinutes;
  // A follow-up on a completed task that stays completed: the task hears nothing.
  const quiet = followup?.retake === "reply";
  const relayTarget =
    candidate.origin === undefined || candidate.thread === undefined
      ? undefined
      : { room: candidate.room, thread: candidate.thread };
  // Replies go under the newest message they answer, so intake sends them there.
  const replyTo = followup?.messages.at(-1)?.id ?? candidate.thread;
  await writeRunRecord(home, record);

  const update = async (
    action: string,
    body: string,
    extra: { refs?: string[]; needsHuman?: boolean } = {},
  ): Promise<void> => {
    await backend.call("taskUpdate", {
      room: candidate.room,
      taskId: candidate.taskId,
      input: {
        action,
        body,
        ...(extra.refs === undefined || extra.refs.length === 0 ? {} : { refs: extra.refs }),
        ...(extra.needsHuman === true ? { needsHuman: true } : {}),
      },
    });
  };
  /** A relay message after the run; a failure to send it never changes the outcome. */
  const relay = async (input: Parameters<typeof relayAfterRun>[0]): Promise<void> => {
    if (relayTarget === undefined || replyTo === undefined) return;
    const message = relayAfterRun(input);
    if (message === null) return;
    try {
      await postInThread(
        backend,
        { ...relayTarget, inReplyTo: replyTo },
        message.body,
        message.purpose,
      );
    } catch (error) {
      host.log(
        `${candidate.taskId} could not post the ${message.purpose}: ${describeError(error)}`,
      );
    }
  };

  const consume = async (): Promise<void> => {
    if (followup === undefined) return;
    await addConsumed(
      home,
      candidate.taskId,
      followup.messages.map((message) => message.id),
    );
  };

  const plan = await planLaunch({
    candidate,
    ...(followup === undefined ? {} : { followup }),
    ranBefore: job.ranBefore,
    resultFile,
    tools:
      host.oguriMcp !== undefined &&
      candidate.oguriTools !== false &&
      agentFlavor(candidate.argv) !== undefined,
  });
  let workspace: Workspace;
  try {
    workspace =
      plan.reuse ??
      (await prepareWorkspace({
        workdir: expandHome(candidate.workdir ?? policy.workdir ?? "~"),
        worktree: candidate.worktree,
        runDir: logDir,
        taskId: candidate.taskId,
        runId: record.runId as string,
      }));
  } catch (error) {
    const reason = `Worker run could not start: ${describeError(error)}`;
    record.finishedAt = new Date(host.now()).toISOString();
    try {
      if (quiet) record.note = reason;
      else await update("blocked", `${reason}. Full log: ${where}`);
      record.outcome = quiet ? "failed" : "blocked";
    } catch (failure) {
      record.outcome = "unreported";
      record.note = describeError(failure);
    }
    await writeRunRecord(home, record);
    // Retrying every pass would fail the same way; the person can write again.
    await consume();
    await relay({ action: "blocked", failure: describeError(error) });
    host.log(`${record.taskId} ${record.outcome}: the run could not start`);
    return;
  }
  record.cwd = workspace.cwd;
  if (workspace.worktree !== undefined) record.worktree = workspace.worktree;
  record.resumed = plan.resumed;
  if (controller.signal.aborted) {
    // Stopped before the executor started: by `abandon`, which already wrote
    // the outcome, or by a cancellation seen in the meantime.
    if (!host.abandoning()) {
      record.outcome = "cancelled";
      record.note = String(controller.signal.reason);
      record.finishedAt = new Date(host.now()).toISOString();
    }
    await writeRunRecord(home, record);
    return;
  }
  await writeRunRecord(home, record);

  if (followup === undefined && relayTarget !== undefined) {
    await acknowledge(backend, agentId, relayTarget, candidate.title, host.log);
  }
  const how = plan.resumed
    ? `resuming its session with runner ${candidate.runner}`
    : `with runner ${candidate.runner}`;
  if (followup?.retake === "continue") {
    await update("progressed", `Follow-up run started by worker ${agentId} ${how}.`);
  } else if (!quiet) {
    await update(
      "started",
      followup === undefined
        ? `Run started by worker ${agentId} with runner ${candidate.runner}.`
        : `Follow-up run started by worker ${agentId} ${how}.`,
    );
  }
  host.log(
    `running ${candidate.taskId} "${candidate.title}" with ${candidate.runner}${followup === undefined ? "" : " (follow-up)"}${plan.resumed ? `, resuming ${record.sessionId ?? ""}` : ""}`,
  );

  const began = Date.now();
  const heartbeat = setInterval(() => {
    if (quiet) return;
    void update(
      "progressed",
      `Still running (${formatDuration(Date.now() - began)} elapsed).`,
    ).catch(() => undefined);
  }, host.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();
  const checker = setInterval(() => {
    void job.check();
  }, host.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  checker.unref();

  // A live session takes a person's message while it runs (ADR 0032).
  const live = candidate.session === "claude-stream" && candidate.thread !== undefined;
  let send: ((text: string) => boolean) | undefined;
  const given = new Set<string>(followup?.messages.map((message) => message.id) ?? []);
  const delivered: string[] = [];
  let delivering = false;
  const deliver = async (): Promise<void> => {
    if (send === undefined || delivering || candidate.thread === undefined) return;
    delivering = true;
    try {
      const fresh = await newMessagesFor(backend, {
        room: candidate.room,
        taskId: candidate.taskId,
        thread: candidate.thread,
        agentId,
        since: record.followupSince ?? record.startedAt,
        policy,
        given: new Set([...given, ...(await readConsumed(home, candidate.taskId))]),
      });
      if (fresh.length === 0) return;
      if (!send(liveText(fresh, agentId))) return;
      for (const message of fresh) {
        given.add(message.header.id);
        delivered.push(message.header.id);
      }
      host.log(
        `${candidate.taskId} gave the running session ${String(fresh.length)} new message(s)`,
      );
    } catch (error) {
      host.log(`${candidate.taskId} could not read new messages: ${describeError(error)}`);
    } finally {
      delivering = false;
    }
  };
  const liveTimer = live
    ? setInterval(() => void deliver(), host.liveIntervalMs ?? DEFAULT_LIVE_INTERVAL_MS)
    : undefined;
  liveTimer?.unref();

  const tooled = await withOguriTools(live ? withReplay(plan.argv) : plan.argv, {
    ...(candidate.oguriTools === undefined ? {} : { oguriTools: candidate.oguriTools }),
    ...(host.oguriMcp === undefined ? {} : { server: host.oguriMcp }),
    env: {
      home,
      agentId,
      taskId: candidate.taskId,
      room: candidate.room,
      runDir: logDir,
      resultFile,
    },
  });

  const argv = tooled;
  let result: RunResult;
  try {
    result = await host.executor({
      argv,
      ...(live
        ? {
            live: {
              bind: (write: (text: string) => boolean) => {
                send = write;
              },
              replay: argv.includes(REPLAY_FLAG),
            },
          }
        : {}),
      cwd: workspace.cwd,
      prompt: plan.stdin,
      timeoutMs: timeoutMinutes * 60_000,
      logDir,
      signal: controller.signal,
      onSpawn: (pid) => {
        record.pid = pid;
        record.spawnedAt = new Date().toISOString();
        void writeRunRecord(home, record).catch(() => undefined);
      },
      // The run acts as this agent: an `oguri` it calls, or the MCP server
      // its agent starts, reads the same home and identity.
      env: {
        ...process.env,
        OGURI_HOME: home,
        OGURI_AGENT: agentId,
        OGURI_TASK_ID: candidate.taskId,
        OGURI_TASK_ROOM: candidate.room,
        OGURI_RUN_DIR: logDir,
        OGURI_RESULT_FILE: resultFile,
        OGURI_SESSION_FILE: sessionFile(logDir),
      },
    });
  } finally {
    clearInterval(heartbeat);
    clearInterval(checker);
    if (liveTimer !== undefined) clearInterval(liveTimer);
  }
  // What the session was given while it ran was answered by it.
  if (delivered.length > 0) await addConsumed(home, candidate.taskId, delivered);

  record.finishedAt = new Date().toISOString();
  record.durationMs = result.durationMs;
  record.exitCode = result.exitCode;
  record.timedOut = result.timedOut;
  if (candidate.session !== undefined) {
    const session = await readSession(candidate.session, logDir);
    // A resumed session keeps its id when the runner does not repeat it.
    const id = session.sessionId ?? (plan.resumed ? followup?.previous.sessionId : undefined);
    if (id !== undefined) record.sessionId = id;
    // The agent's answer, not the JSON envelope around it, is what a summary quotes.
    if (session.text !== undefined) result = { ...result, stdoutTail: session.text };
  }

  // `abandon` already wrote the record, and the process is about to exit.
  // The messages stay unconsumed, so the next start runs the follow-up again.
  if (host.abandoning()) return;
  // The person's messages had their run. Recorded once it ended rather than
  // when it began, so a run cut off by a crash is run again after the restart,
  // with the recovery note; a second pass of this process never sees them,
  // because a task with a run in flight is not watched.
  await consume();

  if (controller.signal.aborted) {
    // The task is no longer ours: whoever cancelled or moved it has said what
    // happens next, and a completion from here would be refused anyway.
    record.outcome = "cancelled";
    record.note = String(controller.signal.reason);
    await writeRunRecord(home, record);
    host.log(`${candidate.taskId} cancelled after ${formatDuration(result.durationMs)}`);
    return;
  }

  const read: ResultRead = await readResult(resultFile);
  if (read.kind === "invalid") record.note = `result.json ignored: ${read.reason}`;
  const question = read.kind === "valid" ? read.result.needsHuman : undefined;

  if (quiet) {
    // The task stays completed, so nothing is published to it. The answer
    // goes to the thread: as a relay for a chat, as a plain message otherwise.
    const ok = succeeded(result) && question === undefined;
    record.outcome = ok ? "answered" : "failed";
    if (relayTarget !== undefined) {
      await relay({
        action: ok ? "completed" : "blocked",
        ...answerFor(read, result),
        ...(question === undefined ? {} : { question }),
        failure: failureReason(result, timeoutMinutes),
      });
    } else if (replyTo !== undefined && candidate.thread !== undefined) {
      try {
        await postInThread(
          backend,
          { room: candidate.room, thread: candidate.thread, inReplyTo: replyTo },
          summarise(result, {
            runner: candidate.runner,
            where,
            timeoutMinutes,
            ...(read.kind === "valid" ? { structured: read.result.summary } : {}),
          }),
        );
      } catch (error) {
        record.outcome = "unreported";
        record.note = describeError(error);
      }
    }
    await writeRunRecord(home, record);
    host.log(
      `${candidate.taskId} follow-up ${record.outcome} after ${formatDuration(result.durationMs)}`,
    );
    return;
  }

  // Read after the run, because the run may have split the task into subtasks.
  const openChildren = await openChildCount(backend, candidate.room, candidate.taskId);
  const report = buildReport({
    result,
    read,
    runner: candidate.runner,
    attempt: record.attempt ?? candidate.attempt + 1,
    ...(candidate.maxAttempts === undefined ? {} : { maxAttempts: candidate.maxAttempts }),
    policy,
    where,
    machine: host.machine,
    cwd: workspace.cwd,
    ...(workspace.worktree === undefined ? {} : { branch: workspace.worktree.branch }),
    openChildren,
  });

  let failure = failureReason(result, timeoutMinutes);
  try {
    await update(report.action, report.body, {
      refs: report.refs,
      needsHuman: report.needsHuman,
    });
    record.outcome = report.action === "progressed" ? "waiting" : report.action;
    if (report.action === "released") {
      await host.backoff.set(candidate.taskId, policy.retry.backoffMinutes);
    }
  } catch (error) {
    // The worker may have ended its own task with its oguri tools (said it was
    // done, or cancelled it), so the task can no longer take the run's
    // transition. The run's report then goes in the thread as a note.
    const ended = await endedBy(backend, candidate.room, candidate.taskId);
    if (ended !== undefined) {
      try {
        await postInThread(
          backend,
          {
            room: candidate.room,
            thread: candidate.thread ?? candidate.taskId,
            inReplyTo: candidate.thread ?? candidate.taskId,
          },
          `${report.body}\n\n(The worker marked this task ${ended} itself; this is the run's report.)`,
        );
      } catch (note) {
        record.note = describeError(note);
      }
      record.outcome = ended;
      await writeRunRecord(home, record);
      host.log(
        `${candidate.taskId} ${ended} by its worker after ${formatDuration(result.durationMs)}`,
      );
      return;
    }
    // The run happened; the record must say so even if reporting it failed.
    // A short, output-free note is the last attempt, because the usual reason
    // is the output itself being refused.
    record.note = describeError(error);
    failure = `its report was refused: ${describeError(error)}`;
    try {
      await update("blocked", fallbackReport(result, timeoutMinutes, describeError(error), where));
      record.outcome = "blocked";
    } catch {
      record.outcome = "unreported";
    }
  }
  await writeRunRecord(home, record);
  if (record.outcome !== "unreported") {
    const action = record.outcome === "waiting" ? "progressed" : report.action;
    await relay({
      action: record.outcome === "blocked" ? "blocked" : action,
      ...answerFor(read, result),
      ...(report.needsHuman && question !== undefined ? { question } : {}),
      failure,
    });
  }
  host.log(`${candidate.taskId} ${record.outcome} after ${formatDuration(result.durationMs)}`);
}

/**
 * The state a worker left its own task in when it ended it during the run,
 * or undefined when the task is still the run's to report on.
 */
async function endedBy(
  backend: Backend,
  room: string,
  taskId: string,
): Promise<"completed" | "cancelled" | undefined> {
  try {
    const detail = await backend.call<{ task: { state: string } } | null>("taskShow", {
      room,
      taskId,
    });
    const state = detail?.task.state;
    return state === "completed" || state === "cancelled" ? state : undefined;
  } catch {
    return undefined;
  }
}
