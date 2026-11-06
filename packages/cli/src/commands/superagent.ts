/**
 * `oguri superagent`, `oguri big`, `oguri small` (ADR 0031).
 *
 * `superagent start` runs this machine's roles in one process: the worker
 * engine and the small superagent when `superagent.small.enabled`, and the big
 * superagent when `superagent.big.enabled`. `big` and `small` are how you talk
 * to them from any machine: the message goes into the conversation room, and
 * the reply comes back the same way.
 */

import {
  effectiveConcurrency,
  loadLocalPolicy,
  type LocalPolicy,
  type MachineRow,
  type TaskDetail,
  type WorkerPolicy,
} from "@oguri/core";
import type { Backend } from "@oguri/daemon";
import { isMachineToken, type Message } from "@oguri/protocol";
import {
  BigSuperagent,
  FROM_SUPERAGENT_TAG,
  SmallSuperagent,
  TO_BIG_TAG,
  TO_SMALL_TAG,
  ensureRoom,
  readSuperagentState,
  workRoom,
} from "@oguri/superagent";
import { Worker, listRuns, todayUsage } from "@oguri/worker";

import { type Ctx, bool, num, usage } from "../context.ts";
import { bold, cyan, dim, green, json, out, red, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";
import { mcpCommand } from "./worker-mcp-config.ts";

const DEFAULT_INTERVAL_S = 15;
const MIN_INTERVAL_S = 5;
const DEFAULT_WAIT_S = 300;

/** This machine's local time, as the owner reads a clock. */
function localTime(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function stamp(line: string): void {
  out(`${dim(localTime())} ${line}`);
}

/**
 * The worker policy as the small superagent runs it. It decides how many
 * workers run here at once, and the big superagent's workers need no
 * `oguri task approve` here, as if it were in `trustedRequesters`.
 *
 * The concurrency number comes from `effectiveConcurrency`, the same function
 * `oguri worker status` reads, so what a machine reports and what it runs are
 * the same number.
 */
export function workerPolicyFor(policy: LocalPolicy): WorkerPolicy {
  const small = policy.superagent.small;
  if (!small.enabled) return { ...policy.worker, concurrency: effectiveConcurrency(policy) };
  return {
    ...policy.worker,
    // The small superagent decides how many workers run here at once.
    concurrency: effectiveConcurrency(policy),
    // The hourly cap must not undercut what it may run at once.
    maxPerHour: Math.max(
      policy.worker.maxPerHour,
      policy.superagent.small.maxWorkers,
      policy.worker.concurrency,
    ),
    ...(small.big === undefined
      ? {}
      : { trustedRequesters: [...new Set([...policy.worker.trustedRequesters, small.big])] }),
  };
}

export async function cmdSuperagent(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "status";
  switch (sub) {
    case "start":
      return await startSuperagent(ctx);
    case "status":
      return await superagentStatus(ctx);
    default:
      usage(`unknown superagent subcommand '${sub}'; use start or status`);
  }
}

async function startSuperagent(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const { big, small } = policy.superagent;
  if (!big.enabled && !small.enabled) {
    out(red("no superagent role is enabled on this machine"));
    out(
      dim(
        `  set superagent.big.enabled and/or superagent.small.enabled in ${ctx.layout.policyPath}`,
      ),
    );
    out(dim("  start from a commented template with: oguri policy --init"));
    return 1;
  }
  if (small.enabled && !policy.worker.enabled) {
    out(
      yellow(
        "superagent.small is on but worker.enabled is false: it will report and answer, but deploy no worker here",
      ),
    );
  }
  const interval = Math.max(MIN_INTERVAL_S, num(ctx, "interval") ?? DEFAULT_INTERVAL_S);
  const once = bool(ctx, "once");
  const agentId = ctx.config.agent.id;
  const machine = ctx.config.agent.machine.id;
  const home = ctx.layout.root;
  const load = async (): Promise<LocalPolicy> => (await loadLocalPolicy(ctx.layout)).policy;

  return await withBackend(
    ctx,
    async (backend) => {
      const worker = new Worker({
        backend,
        agentId,
        machineId: machine,
        home,
        loadPolicy: async () => {
          const current = await load();
          // The worker engine is the small superagent's hands: off with it.
          const workerPolicy = workerPolicyFor(current);
          return current.superagent.small.enabled
            ? workerPolicy
            : { ...workerPolicy, enabled: false };
        },
        log: stamp,
        // Every worker the small superagent deploys gets oguri's tools (ADR 0032).
        oguriMcp: mcpCommand(),
      });
      const smallAgent = new SmallSuperagent({
        backend,
        agentId,
        machine,
        home,
        loadPolicy: async () => {
          const current = await load();
          return { superagent: current.superagent, worker: current.worker };
        },
        running: () => worker.runningTasks(),
        log: (line) => stamp(`${cyan("small")} ${line}`),
      });
      const bigAgent = new BigSuperagent({
        backend,
        agentId,
        home,
        loadPolicy: async () => {
          const current = await load();
          return { superagent: current.superagent, worker: current.worker };
        },
        log: (line) => stamp(`${cyan("big")} ${line}`),
      });
      const roles = [big.enabled ? "big" : null, small.enabled ? "small" : null].filter(Boolean);
      stamp(
        `${green("superagent started")} as ${bold(agentId)} on ${bold(machine)}: ${roles.join(" + ")}`,
      );

      const controller = new AbortController();
      const smallPass = async (): Promise<void> => {
        try {
          // Before the worker looks for work: it sees only rooms it is in.
          const current = await load();
          if (current.superagent.small.enabled) await smallAgent.join(current.superagent);
          const report = await worker.pass();
          for (const id of report.started) stamp(`${green("worker started")} for ${id}`);
          const smallReport = await smallAgent.pass(controller.signal);
          for (const r of smallReport.reported)
            stamp(`${yellow("reported")} ${r.taskId}: ${r.reason}`);
          for (const h of smallReport.handled)
            stamp(`${cyan("small")} ${h.messageId}: ${h.decision}`);
        } catch (error) {
          stamp(
            red(`small pass failed: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
      };
      const bigPass = async (): Promise<void> => {
        try {
          const report = await bigAgent.pass(controller.signal);
          // A decision is logged once, with its reason, as it is made; only the
          // ones that made nothing are said here.
          for (const h of report.handled) {
            if (h.decision === "deferred" || h.decision === "undecided")
              stamp(`${cyan("big")} ${h.messageId}: ${h.decision}`);
          }
          for (const t of report.told) stamp(`${cyan("big")} told the owner about ${t.taskId}`);
          for (const c of report.coordinated)
            stamp(`${cyan("big")} coordinated ${c.key}: ${c.decision}`);
        } catch (error) {
          stamp(red(`big pass failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      };

      // A standing session's process ends with this one; its id stays for the next start.
      const closeSessions = async (): Promise<void> => {
        await Promise.all([bigAgent.close(), smallAgent.close()]);
      };

      if (once) {
        await Promise.all([smallPass(), bigPass()]);
        await worker.idle();
        await closeSessions();
        return 0;
      }

      let stopped = false;
      const loop = async (pass: () => Promise<void>): Promise<void> => {
        while (!stopped) {
          await pass();
          if (stopped) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, interval * 1000);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      };
      const stop = (): void => {
        stopped = true;
        controller.abort();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      // Two loops, so a big superagent thinking for a minute never holds up this machine's workers.
      await Promise.all([loop(smallPass), loop(bigPass)]);
      if (worker.running > 0) {
        stamp(
          `stopping: waiting for ${String(worker.running)} worker(s) to finish (Ctrl-C again to abandon)`,
        );
        let forced = false;
        const force = (signal: NodeJS.Signals): void => {
          if (forced) return;
          forced = true;
          stamp(yellow("abandoning in-flight workers"));
          void worker.abandon().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
        };
        process.once("SIGINT", force);
        process.once("SIGTERM", force);
        await worker.idle();
      }
      await closeSessions();
      stamp("superagent stopped");
      return 0;
    },
    { session: !once },
  );
}

/** How a deployed worker is doing, in the words an owner asks in. */
export function workerStage(detail: Pick<TaskDetail, "task">): {
  rank: number;
  label: string;
} {
  const state = detail.task.state;
  if (state === "blocked" || state === "stuck") return { rank: 0, label: "waiting on you" };
  if (state === "claimed" || state === "in_progress") return { rank: 1, label: "running" };
  if (state === "open")
    return { rank: 2, label: detail.task.assignee === undefined ? "queued" : "running" };
  if (state === "completed") return { rank: 3, label: "done" };
  return { rank: 4, label: "stopped" };
}

function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
}

/**
 * The workers Big deployed, the ones that need the owner first, then the ones
 * running or queued, then the latest done. Read from the transport repository,
 * so it is what every agent sees.
 */
async function showDeployed(ctx: Ctx, tracked: [string, { room: string }][]): Promise<void> {
  if (tracked.length === 0) return;
  const now = Date.now();
  try {
    await withBackend(ctx, async (backend) => {
      const rows: { rank: number; at: number; line: string }[] = [];
      for (const [taskId, entry] of tracked) {
        const detail = await backend
          .call<TaskDetail | null>("taskShow", { room: entry.room, taskId })
          .catch(() => null);
        if (detail === null || detail === undefined) continue;
        // A plan's parent is the plan, not a worker.
        if (detail.children.length > 0) continue;
        const stage = workerStage(detail);
        const label = stage.label.padEnd(14);
        const colored =
          stage.rank === 0 ? yellow(label) : stage.rank <= 2 ? green(label) : dim(label);
        rows.push({
          rank: stage.rank,
          at: Date.parse(detail.updatedAt),
          line: `    ${colored} ${taskId.slice(-6)}  ${detail.task.title.slice(0, 60)}  ${dim(age(detail.updatedAt, now))}`,
        });
      }
      // By stage, then the latest first.
      rows.sort((a, b) => a.rank - b.rank || b.at - a.at);
      const active = rows.filter((row) => row.rank <= 2);
      const done = rows.filter((row) => row.rank > 2).slice(0, Math.max(0, 8 - active.length));
      for (const row of [...active, ...done]) out(row.line);
      const hidden = rows.length - active.length - done.length;
      if (hidden > 0) out(dim(`    … ${String(hidden)} more done or stopped`));
      return 0;
    });
  } catch {
    // Without the transport, the ids are still worth showing.
    for (const [taskId, entry] of tracked.slice(0, 10)) out(dim(`    ${taskId} in ${entry.room}`));
  }
}

async function superagentStatus(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const { big, small } = policy.superagent;
  const bigState = await readSuperagentState(ctx.layout.root, "big", Date.now());
  const runs = (await listRuns(ctx.layout.root, 50)).filter((run) => run.outcome === "running");
  const today = await todayUsage(ctx.layout.root);
  // The number the worker engine actually applies, not the section that set it.
  const concurrency = effectiveConcurrency(policy);
  if (bool(ctx, "json")) {
    json({
      superagent: policy.superagent,
      concurrency,
      tracked: bigState.tracked,
      running: runs,
      today,
    });
    return 0;
  }
  out(bold("superagent"));
  out(`  agent       ${ctx.config.agent.id} on ${ctx.config.agent.machine.id}`);
  out(
    `  big         ${big.enabled ? green("on") : dim("off")}  room ${big.room} · workers in ${workRoom(policy.superagent)}${big.enabled ? ` · coordinate ${big.coordinate ? "on" : "off"}` : ""}`,
  );
  out(
    `  small       ${small.enabled ? green("on") : dim("off")}${small.big === undefined ? "" : `  · trusts ${small.big}`}${small.enabled && !policy.worker.enabled ? yellow("  · worker.enabled is false: no hands") : ""}`,
  );
  out(
    `  concurrency ${String(concurrency)} at once${small.enabled ? dim(` (superagent.small.maxWorkers)`) : dim(` (worker.concurrency)`)}`,
  );
  if (big.enabled) {
    const tracked = Object.entries(bigState.tracked);
    out(`  deployed    ${String(tracked.length)} worker(s) followed`);
    await showDeployed(ctx, tracked);
  }
  out(`  running     ${String(runs.length)} worker(s) on this machine`);
  for (const run of runs) out(dim(`    ${run.taskId} ${run.title} (${run.runner})`));
  // The figure is a known subtotal, never a total: runners that print no price
  // and runs still in flight are outside it, so the count is said alongside.
  const cost =
    today.costUsd === null
      ? ""
      : today.unpricedRuns === 0
        ? ` · $${today.costUsd.toFixed(2)} total`
        : ` · $${today.costUsd.toFixed(2)} known subtotal · ${String(today.unpricedRuns)} run(s) unpriced`;
  out(`  today       ${String(today.runs)} worker run(s)${cost}`);
  out("  cost scope  worker runs only; excludes Big/Small superagent brain sessions");
  out("");
  out(dim('talk to them:  oguri big "<message>"   ·   oguri small <agent|machine:id> "<message>"'));
  return 0;
}

/** Wait for a superagent's first reply to a message, printing it. */
async function awaitReply(
  backend: Backend,
  room: string,
  message: Message,
  seconds: number,
): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await backend.call("sync").catch(() => undefined);
    const messages = await backend.call<Message[]>("read", { room }).catch(() => [] as Message[]);
    const replies = messages.filter(
      (m) =>
        m.header.inReplyTo === message.header.id && m.header.tags.includes(FROM_SUPERAGENT_TAG),
    );
    if (replies.length > 0) {
      for (const r of replies) {
        out(`${bold(r.header.from)} ${dim(r.header.ts.slice(11, 19))}`);
        out(r.body);
        out("");
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

async function talk(
  ctx: Ctx,
  body: string,
  address: (backend: Backend) => Promise<{ tags: string[]; mentions?: string[]; who: string }>,
): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const room = policy.superagent.big.room;
  const detach = bool(ctx, "detach");
  const waitS = num(ctx, "wait") ?? DEFAULT_WAIT_S;
  return await withBackend(ctx, async (backend) => {
    const extra = await address(backend);
    const who = extra.who;
    await ensureRoom(backend, room, "Talk to the superagents here.");
    const sent = await backend.call<Message>("send", {
      room,
      input: {
        body,
        kind: "msg",
        needs: "none",
        tags: extra.tags,
        ...(extra.mentions === undefined ? {} : { mentions: extra.mentions }),
      },
    });
    if (bool(ctx, "json") && detach) {
      json({ room, id: sent.header.id, thread: sent.header.thread });
      return 0;
    }
    out(dim(`sent to ${who} in ${room} (${sent.header.id})`));
    if (detach) {
      out(dim(`the reply will be in: oguri read ${room}`));
      return 0;
    }
    out(
      dim(
        `waiting up to ${String(waitS)}s for ${who}... (Ctrl-C is safe; the reply will be in 'oguri read ${room}')`,
      ),
    );
    if (await awaitReply(backend, room, sent, waitS)) return 0;
    out(
      yellow(
        `no reply yet. Is 'oguri superagent start' running for ${who}? It will answer in 'oguri read ${room}'.`,
      ),
    );
    return 1;
  });
}

/** `oguri big "<message>"` — talk to the big superagent. */
export async function cmdBig(ctx: Ctx): Promise<number> {
  const body = ctx.positionals.slice(1).join(" ").trim();
  if (body === "") usage('usage: oguri big "<message>" [--detach] [--wait <seconds>]');
  return await talk(ctx, body, async () => ({ tags: [TO_BIG_TAG], who: "the big superagent" }));
}

/** The agent a `small` message is for: an agent id, or the only agent on `machine:<id>`. */
async function resolveSmall(backend: Backend, target: string): Promise<string> {
  if (!isMachineToken(target)) return target;
  const machineId = target.slice("machine:".length);
  const machines = await backend.call<MachineRow[]>("machines");
  const agents = machines.find((m) => m.id === machineId)?.agents.map((a) => a.id) ?? [];
  if (agents.length === 1) return agents[0] as string;
  if (agents.length === 0) usage(`no agent is known on ${target}; see 'oguri agents'`);
  usage(`${target} has several agents (${agents.join(", ")}); name one`);
}

/** `oguri small <agent|machine:id> "<message>"` — talk to one machine's small superagent. */
export async function cmdSmall(ctx: Ctx): Promise<number> {
  const target = ctx.positionals[1];
  const body = ctx.positionals.slice(2).join(" ").trim();
  if (target === undefined || body === "") {
    usage('usage: oguri small <agent|machine:id> "<message>" [--detach] [--wait <seconds>]');
  }
  return await talk(ctx, body, async (backend) => {
    const agent = await resolveSmall(backend, target as string);
    return { tags: [TO_SMALL_TAG], mentions: [agent], who: `the small superagent ${agent}` };
  });
}
