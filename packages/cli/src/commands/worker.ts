import { loadLocalPolicy } from "@oguri/core";
import { Worker, listRuns } from "@oguri/worker";

import { type Ctx, bool, num, usage } from "../context.ts";
import { ago, bold, cyan, dim, green, json, out, red, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";
import { workerPolicyFor } from "./superagent.ts";
import { cmdWorkerMcpConfig, mcpCommand } from "./worker-mcp-config.ts";
import {
  SERVICE_ENV,
  workerInstall,
  workerServiceStatus,
  workerUninstall,
} from "../worker-service.ts";

const DEFAULT_INTERVAL_S = 30;
const MIN_INTERVAL_S = 5;

function stamp(line: string): void {
  out(`${dim(new Date().toISOString().slice(11, 19))} ${line}`);
}

/**
 * `oguri worker start|status|runs|install|uninstall` — run assigned tasks on this machine (ADR 0026).
 *
 * The worker only acts when `worker.enabled` is set in the machine-local
 * policy. It re-reads that file before every pass, so switching it off stops
 * new runs without a restart.
 */
export async function cmdWorker(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "status";
  switch (sub) {
    case "start":
      return await startWorker(ctx);
    case "status":
      return await workerStatus(ctx);
    case "runs":
      return await workerRuns(ctx);
    case "install":
      for (const line of await workerInstall(ctx.config.agent.id, ctx.layout)) out(line);
      return 0;
    case "mcp-config":
      return await cmdWorkerMcpConfig(ctx);
    case "uninstall":
      for (const line of await workerUninstall(ctx.config.agent.id, ctx.layout)) out(line);
      return 0;
    default:
      usage(
        `unknown worker subcommand '${sub}'; use start, status, runs, install, uninstall, or mcp-config`,
      );
  }
}

async function startWorker(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  // Under a login service a refusal would only be restarted, over and over.
  // The worker rereads the policy every pass, so it waits for `enabled` instead.
  const asService = process.env[SERVICE_ENV] === "1";
  if (!policy.worker.enabled && !asService) {
    out(red("worker is disabled on this machine"));
    out(dim(`  set worker.enabled: true and worker.runners in ${ctx.layout.policyPath}`));
    out(dim("  start from a commented template with: oguri policy --init"));
    return 1;
  }
  const interval = Math.max(MIN_INTERVAL_S, num(ctx, "interval") ?? DEFAULT_INTERVAL_S);
  const once = bool(ctx, "once");

  return await withBackend(
    ctx,
    async (backend) => {
      const worker = new Worker({
        backend,
        agentId: ctx.config.agent.id,
        machineId: ctx.config.agent.machine.id,
        home: ctx.layout.root,
        // The big superagent's workers run here without approval when this machine names it.
        loadPolicy: async () => workerPolicyFor((await loadLocalPolicy(ctx.layout)).policy),
        log: stamp,
        // claude and codex runs get oguri's tools (ADR 0032).
        oguriMcp: mcpCommand(),
      });
      stamp(
        `${green("worker started")} as ${bold(ctx.config.agent.id)}; runners: ${Object.keys(policy.worker.runners).join(", ")}`,
      );

      let wasEnabled = true;
      const passOnce = async (): Promise<void> => {
        try {
          const report = await worker.pass();
          // Said once per change: a service waiting for `enabled` passes every 30s.
          if (!report.enabled && wasEnabled) {
            stamp(yellow("worker.enabled is false; no new runs until it is set"));
          }
          wasEnabled = report.enabled;
          for (const id of report.followups ?? []) {
            stamp(`${cyan("follow-up")} ${id}: a person wrote in the thread`);
          }
          for (const r of report.rolledUp ?? []) {
            stamp(`${green("rolled up")} ${r.taskId}: parent ${r.action}`);
          }
          for (const r of report.recovered ?? []) {
            stamp(
              `${yellow("recovered")} ${r.taskId}: abandoned run closed${r.published === null ? "" : `, task ${r.published}`}`,
            );
          }
        } catch (error) {
          stamp(red(`pass failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      };

      if (once) {
        await passOnce();
        await worker.idle();
        return 0;
      }

      let stopped = false;
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const stop = (): void => {
          stopped = true;
          clearTimeout(timer);
          resolve();
        };
        const loop = (): void => {
          if (stopped) return;
          void passOnce().then(() => {
            if (!stopped) timer = setTimeout(loop, interval * 1000);
          });
        };
        loop();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      if (worker.running > 0) {
        stamp(
          `stopping: waiting for ${String(worker.running)} run(s) to finish (Ctrl-C again to abandon)`,
        );
        // A second signal stops the runs now. Their records are marked
        // abandoned first, so the next start settles their tasks instead of
        // finding them `running` with nobody behind them.
        let forced = false;
        const force = (signal: NodeJS.Signals): void => {
          if (forced) return;
          forced = true;
          stamp(yellow("abandoning in-flight runs"));
          void worker.abandon().finally(() => {
            process.exit(signal === "SIGINT" ? 130 : 143);
          });
        };
        process.once("SIGINT", force);
        process.once("SIGTERM", force);
        await worker.idle();
      }
      stamp("worker stopped");
      return 0;
    },
    { session: !once },
  );
}

async function workerStatus(ctx: Ctx): Promise<number> {
  const resolved = await loadLocalPolicy(ctx.layout);
  const worker = resolved.policy.worker;
  const runs = await listRuns(ctx.layout.root, 50);
  const hourAgo = Date.now() - 60 * 60_000;
  const lastHour = runs.filter((run) => Date.parse(run.startedAt) > hourAgo).length;
  const running = runs.filter((run) => run.outcome === "running");
  const service = await workerServiceStatus(ctx.config.agent.id, ctx.layout);

  if (bool(ctx, "json")) {
    json({ worker, sources: resolved.sources, runsLastHour: lastHour, running, service });
    return 0;
  }
  out(bold("worker"));
  out(`  enabled         ${worker.enabled ? green("yes") : dim("no — oguri starts nothing here")}`);
  const names = Object.keys(worker.runners);
  const traits = (name: string): string => {
    const runner = worker.runners[name];
    const marks = [
      ...(runner?.worktree === true ? ["worktree"] : []),
      ...(runner?.session === undefined
        ? []
        : [`session ${runner.session}${runner.resume === undefined ? "" : ", resumes"}`]),
    ];
    return marks.length === 0 ? "" : dim(` (${marks.join("; ")})`);
  };
  out(
    `  runners         ${names.length === 0 ? dim("none") : names.map((n) => cyan(n) + traits(n)).join(", ")}`,
  );
  if (worker.defaultRunner !== undefined) out(`  defaultRunner   ${worker.defaultRunner}`);
  out(`  concurrency     ${String(worker.concurrency)}`);
  out(
    `  hourly budget   ${String(Math.max(0, worker.maxPerHour - lastHour))} of ${String(worker.maxPerHour)} left`,
  );
  out(`  timeout         ${String(worker.timeoutMinutes)} min`);
  out(`  workdir         ${worker.workdir ?? "~"}`);
  out(
    `  trusted         ${worker.trustedRequesters.length === 0 ? dim("none — remote tasks wait for approval") : worker.trustedRequesters.join(", ")}`,
  );
  out(`  onAbandon       ${worker.onAbandon}`);
  out(
    `  on failure      ${worker.retry.onFailure ?? dim("release while attempts remain, else block")}; backoff ${String(worker.retry.backoffMinutes)} min`,
  );
  out(
    `  follow-ups      ${worker.followupDays === 0 ? dim("only on unfinished tasks") : `on unfinished tasks, and up to ${String(worker.followupDays)} day(s) after completion`}`,
  );
  out(
    `  capabilities    ${worker.capabilities.length === 0 ? dim("none — only tasks offered here") : worker.capabilities.join(", ")}`,
  );
  out(
    `  start at login  ${service.installed ? green(`yes — ${service.supervisor} unit installed`) : dim(service.supervisor === "unsupported" ? "not supported here" : "no — oguri worker install")}`,
  );
  if (service.unit !== null && service.installed) out(dim(`  unit            ${service.unit}`));
  if (running.length > 0) {
    out();
    out(bold("running"));
    for (const run of running) out(`  ${run.taskId}  ${run.title}  ${dim(ago(run.startedAt))}`);
  }
  return 0;
}

async function workerRuns(ctx: Ctx): Promise<number> {
  const runs = await listRuns(ctx.layout.root, num(ctx, "limit") ?? 20);
  if (bool(ctx, "json")) {
    json(runs);
    return 0;
  }
  if (runs.length === 0) {
    out(dim("no runs recorded on this machine"));
    return 0;
  }
  for (const run of runs) {
    const outcome =
      run.outcome === "completed" || run.outcome === "answered"
        ? green(run.outcome)
        : run.outcome === "running"
          ? cyan(run.outcome)
          : run.outcome === "abandoned" || run.outcome === "unreported" || run.outcome === "failed"
            ? red(run.outcome)
            : yellow(run.outcome);
    const exit =
      run.exitCode === undefined || run.exitCode === null
        ? ""
        : dim(` exit ${String(run.exitCode)}`);
    const branch = run.worktree === undefined ? "" : dim(` ${run.worktree.branch}`);
    const followup =
      run.followup === true
        ? cyan(run.resumed === true ? " follow-up (resumed)" : " follow-up")
        : "";
    const session = run.sessionId === undefined ? "" : dim(` session ${run.sessionId.slice(0, 8)}`);
    out(
      `${outcome.padEnd(20)} ${run.taskId}  ${run.title}  ${dim(run.runner)}${exit}${followup}${session}${branch}  ${dim(ago(run.startedAt))}`,
    );
  }
  return 0;
}
