import { loadLocalPolicy, type IntakePolicy } from "@oguri/core";
import {
  FeishuClient,
  FeishuSource,
  FileOutbox,
  Intake,
  IntakeReplies,
  emptyState,
  intakeDir,
  intakeRooms,
  readIntakeState,
  relayBackend,
} from "@oguri/intake";
import {
  type ServiceSpec,
  detectSupervisor,
  installService,
  isServiceInstalled,
  uninstallService,
  unitPath,
} from "@oguri/daemon";
import type { Layout } from "@oguri/core";

import { type Ctx, bool, usage } from "../context.ts";
import { ago, bold, cyan, dim, green, json, out, red, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";
import { cliEntryFor } from "../worker-service.ts";

/** Set in the unit, so `intake start` knows a supervisor will restart it on failure. */
export const INTAKE_SERVICE_ENV = "OGURI_INTAKE_SERVICE";

function stamp(line: string): void {
  out(`${dim(new Date().toISOString().slice(11, 19))} ${line}`);
}

/** One login unit per agent, beside the worker's and never under its names. */
export function intakeService(agentId: string, layout: Layout): ServiceSpec {
  return {
    label: `dev.oguri.intake.${agentId}`,
    unit: `oguri-intake-${agentId}.service`,
    description: `oguri intake for ${agentId}`,
    logName: `intake-${agentId}`,
    manual: "Run 'oguri intake start' yourself, or use a scheduled task.",
    env: {
      OGURI_HOME: layout.root,
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      [INTAKE_SERVICE_ENV]: "1",
    },
  };
}

/**
 * `oguri intake start|status|test|install|uninstall` — bridge a Feishu app's
 * chats to rooms (ADR 0030).
 *
 * Off unless `intake.enabled` is set in the machine-local policy, which also
 * holds the app secret. Nothing here prints the secret.
 */
export async function cmdIntake(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "status";
  switch (sub) {
    case "start":
      return await startIntake(ctx);
    case "status":
      return await intakeStatus(ctx);
    case "test":
      return await testIntake(ctx);
    case "install": {
      const { command, args } = cliEntryFor(process.execPath, process.argv[1]);
      const result = await installService(
        command,
        [...args, "intake", "start"],
        intakeService(ctx.config.agent.id, ctx.layout),
      );
      out(`${result.started ? "installed and started" : "installed"} via ${result.kind}`);
      out(`unit: ${result.path}`);
      if (result.hint !== "") out(result.hint);
      return 0;
    }
    case "uninstall": {
      const result = await uninstallService(intakeService(ctx.config.agent.id, ctx.layout));
      out(result.removed ? `removed the ${result.kind} unit` : `no ${result.kind} unit to remove`);
      return 0;
    }
    default:
      usage(`unknown intake subcommand '${sub}'; use start, status, test, install, or uninstall`);
  }
}

function disabledHint(ctx: Ctx): void {
  out(red("intake is disabled on this machine"));
  out(dim(`  set intake.enabled: true and intake.feishu in ${ctx.layout.policyPath}`));
  out(dim("  start from a commented template with: oguri policy --init"));
}

async function startIntake(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  // Under a login service a refusal would only be restarted; wait for `enabled` instead.
  const asService = process.env[INTAKE_SERVICE_ENV] === "1";
  if ((!policy.intake.enabled || policy.intake.feishu === undefined) && !asService) {
    disabledHint(ctx);
    return 1;
  }
  const once = bool(ctx, "once");
  return await withBackend(
    ctx,
    async (backend) => {
      const loadPolicy = async (): Promise<IntakePolicy> =>
        (await loadLocalPolicy(ctx.layout)).policy.intake;
      const replies = new IntakeReplies({
        backend: relayBackend(backend),
        home: ctx.layout.root,
        loadPolicy,
        log: stamp,
      });
      const intake = new Intake({
        backend,
        agentId: ctx.config.agent.id,
        home: ctx.layout.root,
        loadPolicy,
        outbox: replies.outbox,
        log: stamp,
      });
      const chats = policy.intake.feishu?.chats.map((c) => `${c.id}→${c.room}`) ?? [];
      stamp(
        `${green("intake started")} as ${bold(ctx.config.agent.id)}; chats: ${chats.join(", ") || "none"}`,
      );
      if (once) {
        const report = await intake.poll();
        if (report.idle !== undefined) stamp(yellow(report.idle));
        else await replies.tick();
        await intake.release();
        return 0;
      }
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      let lastIdle: string | undefined;
      const loop = async (): Promise<void> => {
        while (!controller.signal.aborted) {
          const report = await intake.poll(controller.signal);
          // Said once per change: a second machine polls every few seconds.
          if (report.idle !== lastIdle && report.idle !== undefined) stamp(yellow(report.idle));
          lastIdle = report.idle;
          // Only the machine holding the claim answers, or a chat hears everything twice.
          if (report.idle === undefined) await replies.tick(controller.signal);
          const seconds =
            (await loadLocalPolicy(ctx.layout)).policy.intake.feishu?.pollSeconds ?? 10;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, seconds * 1000);
            controller.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      };
      await loop();
      await intake.release();
      stamp("intake stopped");
      return 0;
    },
    { session: !once },
  );
}

function chatRows(policy: IntakePolicy, names: Record<string, { mode?: string; name?: string }>) {
  return (policy.feishu?.chats ?? []).map((chat) => ({
    id: chat.id,
    room: chat.room,
    ...(chat.target === undefined ? {} : { target: chat.target }),
    ...(chat.requires === undefined ? {} : { requires: chat.requires }),
    anyone: chat.anyone,
    ...(names[chat.id]?.name === undefined ? {} : { name: names[chat.id]?.name }),
    ...(names[chat.id]?.mode === undefined ? {} : { mode: names[chat.id]?.mode }),
  }));
}

async function intakeStatus(ctx: Ctx): Promise<number> {
  const resolved = await loadLocalPolicy(ctx.layout);
  const policy = resolved.policy.intake;
  const state = await readIntakeState(ctx.layout.root);
  const spec = intakeService(ctx.config.agent.id, ctx.layout);
  const supervisor = detectSupervisor();
  const service = {
    supervisor,
    installed: await isServiceInstalled(spec),
    unit: supervisor === "unsupported" ? null : unitPath(supervisor, spec),
  };
  const chats = chatRows(policy, state.chats);
  const summary = {
    enabled: policy.enabled,
    source: policy.feishu === undefined ? null : "feishu",
    appId: policy.feishu?.appId ?? null,
    allowed: policy.feishu?.allowed ?? [],
    direct: policy.feishu?.direct ?? false,
    pollSeconds: policy.feishu?.pollSeconds ?? null,
    chats,
    rooms: intakeRooms(policy),
    botId: state.botId ?? null,
    claim: state.status.claim ?? null,
    idle: state.status.idle ?? null,
    lastPollAt: state.status.lastPollAt ?? null,
    lastError: state.status.lastError ?? null,
    backoffUntil: state.status.backoffUntil ?? null,
    tasks: new Set(Object.values(state.tasks).map((t) => t.taskId)).size,
    outbox: await new FileOutbox({ stateDir: intakeDir(ctx.layout.root), senders: {} }).status(),
    sources: resolved.sources,
    service,
  };
  if (bool(ctx, "json")) {
    json(summary);
    return 0;
  }
  out(bold("intake"));
  out(
    `  enabled         ${policy.enabled ? green("yes") : dim("no — nothing is read from chat here")}`,
  );
  out(
    `  source          ${summary.source === null ? dim("none") : `feishu app ${summary.appId ?? ""}`}`,
  );
  out(`  bot             ${state.botId ?? dim("not looked up yet — oguri intake test")}`);
  out(
    `  allowed         ${summary.allowed.length === 0 ? dim("nobody — only chats with anyone: true") : summary.allowed.join(", ")}`,
  );
  out(`  direct          ${summary.direct ? "yes" : "no"}`);
  if (chats.length === 0) out(`  chats           ${dim("none")}`);
  for (const chat of chats) {
    const name = chat.name === undefined ? "" : ` ${dim(`(${chat.name})`)}`;
    const target = chat.target === undefined ? "" : dim(` for ${chat.target}`);
    out(
      `  chat            ${cyan(chat.id)}${name} → ${chat.room}${target}${chat.anyone ? dim(" anyone") : ""}`,
    );
  }
  const claim = state.status.claim;
  out(
    `  claim           ${claim === undefined ? dim("not taken yet") : claim.mine ? green(`held here (${claim.resource})`) : yellow(`held by ${claim.holder}`)}`,
  );
  out(
    `  last poll       ${state.status.lastPollAt === undefined ? dim("never") : ago(state.status.lastPollAt)}`,
  );
  if (state.status.idle !== undefined) out(`  idle            ${yellow(state.status.idle)}`);
  if (state.status.lastError !== undefined) {
    out(
      `  last error      ${red(state.status.lastError.message)} ${dim(ago(state.status.lastError.at))}`,
    );
  }
  if (state.status.backoffUntil !== undefined)
    out(`  backing off     until ${state.status.backoffUntil}`);
  out(`  tasks           ${String(summary.tasks)} from chat`);
  out(
    `  replies         ${String(summary.outbox.queued)} queued, ${String(summary.outbox.sent)} sent, ${String(summary.outbox.dropped)} dropped`,
  );
  for (const problem of summary.outbox.problems) {
    out(`  reply problem   ${yellow(JSON.stringify(problem))}`);
  }
  out(
    `  start at login  ${service.installed ? green(`yes — ${service.supervisor} unit installed`) : dim(service.supervisor === "unsupported" ? "not supported here" : "no — oguri intake install")}`,
  );
  return 0;
}

async function testIntake(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const feishu = policy.intake.feishu;
  if (feishu === undefined) {
    out(red("no intake.feishu section in the policy"));
    out(dim(`  add one to ${ctx.layout.policyPath}`));
    return 1;
  }
  // A fresh state, so the test asks Feishu rather than the cache.
  const source = new FeishuSource({
    client: new FeishuClient({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      ...(feishu.apiUrl === undefined ? {} : { apiUrl: feishu.apiUrl }),
    }),
    policy: feishu,
    state: emptyState(),
  });
  const rows: { id: string; ok: boolean; name?: string; mode?: string; error?: string }[] = [];
  let botId: string;
  try {
    botId = await source.botId();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (bool(ctx, "json")) json({ ok: false, error: message });
    else out(`${red("✗")} bot info: ${message}`);
    return 1;
  }
  for (const chat of feishu.chats) {
    try {
      const info = await source.chatInfo(chat.id);
      rows.push({ id: chat.id, ok: true, ...info });
    } catch (error) {
      rows.push({
        id: chat.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const ok = rows.every((row) => row.ok);
  if (bool(ctx, "json")) {
    json({ ok, botId, chats: rows });
    return ok ? 0 : 1;
  }
  out(`${green("✓")} bot ${botId}`);
  for (const row of rows) {
    out(
      row.ok
        ? `${green("✓")} ${row.id}  ${row.name ?? dim("(no name)")} ${dim(row.mode ?? "")}`
        : `${red("✗")} ${row.id}  ${row.error ?? ""}`,
    );
  }
  return ok ? 0 : 1;
}
