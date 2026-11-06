/**
 * `oguri runner grant | revoke | list | request` — a person's consent to the
 * runners this machine's worker may start (see `@oguri/core` runner-grants).
 *
 * `grant` and `revoke` are a person's, at this machine's terminal. They run
 * direct, never through the daemon — a socket has no person on the other end
 * — and refuse inside a worker's run, which is what Big and Small deploy, so
 * no superagent and no worker can grant itself a runner. `list` and `request`
 * are for anyone: listing grants nothing, and a request only asks.
 *
 * Nothing here edits `policy.yaml`. A grant picks among the runners a person
 * already wrote there; it never adds a command.
 */

import { userInfo } from "node:os";

import {
  RunnerGrantStore,
  grantRefusal,
  grantRows,
  loadLocalPolicy,
  runnerDigest,
  shortDigest,
  type GrantActor,
} from "@oguri/core";
import { runOf } from "@oguri/daemon";
import { isUlid } from "@oguri/protocol";

import { type Ctx, bool, list, str, usage } from "../context.ts";
import { ago, bold, cyan, dim, errline, green, json, out, red, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";

const DURATION = /^(\d+)([mhd])$/;

/** `--expires` as a duration (`12h`, `7d`) or an RFC 3339 time. */
export function parseExpiry(raw: string, now: number = Date.now()): string {
  const duration = DURATION.exec(raw);
  if (duration !== null) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as "m" | "h" | "d"];
    return new Date(now + Number(duration[1]) * unit).toISOString();
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) usage(`--expires must be a duration like 12h or 7d, or a time`);
  if (at <= now) usage("--expires is in the past");
  return new Date(at).toISOString();
}

function store(ctx: Ctx): RunnerGrantStore {
  return RunnerGrantStore.forHome(ctx.layout.root);
}

function actorOf(ctx: Ctx): GrantActor {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry; the human name from config still identifies the grant.
  }
  return {
    human: ctx.config.agent.human.name,
    user,
    agent: ctx.config.agent.id,
    via: "terminal",
  };
}

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Refuse a grant or revoke from a run or a pipe, and audit that it was tried. */
async function refuseUnlessPerson(ctx: Ctx, action: string, runner: string): Promise<boolean> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const refusal = grantRefusal(process.env, interactive);
  if (refusal === null) return false;
  await store(ctx).audit({
    action: "refused",
    runner,
    actor: { agent: ctx.config.agent.id, via: process.env["OGURI_TASK_ID"] ? "worker" : "cli" },
    detail: `${action}: ${refusal}`,
  });
  errline(red(`✗ runner ${action} refused: ${refusal}`));
  errline(dim("  this check prevents a run or a script from granting itself a runner;"));
  errline(dim("  it does not authenticate a person. Run it yourself, at a terminal."));
  return true;
}

export async function cmdRunnerGrants(ctx: Ctx, sub: string): Promise<number> {
  switch (sub) {
    case "grant":
      return await runnerGrant(ctx);
    case "revoke":
      return await runnerRevoke(ctx);
    case "list":
    case "grants":
      return await runnerList(ctx);
    case "request":
      return await runnerRequest(ctx);
    default:
      usage(`unknown runner subcommand '${sub}'; use presets, grant, revoke, list, or request`);
  }
}

/** `oguri runner grant <name> [--for <agent>…] [--expires 12h] [note]` */
async function runnerGrant(ctx: Ctx): Promise<number> {
  const name = ctx.positionals[2];
  if (name === undefined) usage("runner grant needs a runner name from worker.runners");
  if (await refuseUnlessPerson(ctx, "grant", name)) return 1;

  const { policy } = await loadLocalPolicy(ctx.layout);
  const runner = policy.worker.runners[name];
  if (runner === undefined) {
    const names = Object.keys(policy.worker.runners);
    errline(red(`✗ runner '${name}' is not in worker.runners (${names.join(", ") || "none"})`));
    errline(dim(`  add it to ${ctx.layout.policyPath} first; a grant never adds a command`));
    return 1;
  }
  const forAgents = list(ctx, "for");
  const expiresRaw = str(ctx, "expires");
  const expiresAt = expiresRaw === undefined ? undefined : parseExpiry(expiresRaw);
  const note = ctx.positionals.slice(3).join(" ");
  const digest = runnerDigest(runner);
  const grants = store(ctx);
  const before = await grants.state();

  out(bold(`Grant runner '${name}' on this machine`));
  out(dim(`  argv     ${runner.argv.join(" ")}`));
  if (runner.resume !== undefined) out(dim(`  resume   ${runner.resume.join(" ")}`));
  if (runner.model !== undefined) out(dim(`  model    ${runner.model}`));
  out(dim(`  digest   ${shortDigest(digest)} — editing this entry later voids the grant`));
  out(
    dim(
      `  for      ${forAgents.length === 0 ? "any requester the worker serves" : forAgents.join(", ")}`,
    ),
  );
  out(dim(`  expires  ${expiresAt ?? "when revoked"}`));
  if (!before.enforced) {
    out(
      yellow(
        "  This is the first grant: from now on a runner runs only under a grant, and every other runner waits.",
      ),
    );
  }
  if (!(await confirm(yellow("Grant it?")))) {
    out(dim("nothing granted"));
    return 1;
  }
  const grant = await grants.grant(
    {
      runner: name,
      digest,
      ...(forAgents.length === 0 ? {} : { for: forAgents }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(note === "" ? {} : { note }),
    },
    actorOf(ctx),
  );
  if (bool(ctx, "json")) json(grant);
  else {
    out(green(`✓ granted '${name}'`) + dim(` ${grant.id} · recorded on this machine only`));
    out(dim(`  ${grants.grantsPath}`));
  }
  return 0;
}

/** `oguri runner revoke <name>` */
async function runnerRevoke(ctx: Ctx): Promise<number> {
  const name = ctx.positionals[2];
  if (name === undefined) usage("runner revoke needs a runner name");
  if (await refuseUnlessPerson(ctx, "revoke", name)) return 1;
  const revoked = await store(ctx).revoke(name, actorOf(ctx));
  if (bool(ctx, "json")) json({ runner: name, revoked });
  else if (revoked) {
    out(green(`✓ grant for '${name}' withdrawn`));
    out(dim("  the worker refuses it from its next pass; no restart needed"));
  } else out(dim(`'${name}' had no grant`));
  return 0;
}

/** `oguri runner list [--json]` — every runner, whether it is granted, and what is asked. */
async function runnerList(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);
  const grants = store(ctx);
  const state = await grants.state();
  const rows = grantRows(state, policy.worker.runners);
  const requests = await grants.requests();
  // A request is open while its runner is not granted.
  const open = requests.filter(
    (request) =>
      !rows.some((row) => row.runner === request.runner && row.allowed && state.enforced),
  );
  if (bool(ctx, "json")) {
    json({ enforced: state.enforced, corrupt: state.corrupt, runners: rows, requests: open });
    return 0;
  }
  out(
    `${bold("runner grants")}  ${
      state.enforced
        ? yellow(state.corrupt ? "on — but the file is unreadable, so nothing runs" : "on")
        : dim("off — no grants file, every runner in worker.runners may run")
    }`,
  );
  for (const row of rows) {
    const mark = !state.enforced ? dim("·") : row.allowed ? green("✓") : red("✗");
    const who =
      row.grant === undefined
        ? ""
        : dim(
            ` granted by ${row.grant.grantedBy.human} ${ago(row.grant.grantedAt)}${row.grant.for === undefined ? "" : ` for ${row.grant.for.join(", ")}`}${row.grant.expiresAt === undefined ? "" : ` until ${row.grant.expiresAt}`}`,
          );
    out(`  ${mark} ${cyan(row.runner.padEnd(14))} ${dim(shortDigest(row.digest))}${who}`);
    if (state.enforced && row.reason !== undefined) out(dim(`      ${row.reason}`));
  }
  if (open.length > 0) {
    out("");
    out(bold("asked for"));
    for (const request of open.slice(-20)) {
      out(
        `  ${cyan(request.runner.padEnd(14))} ${request.by} ${dim(`via ${request.via} · ${ago(request.at)}`)}`,
      );
      out(dim(`      ${request.reason}`));
    }
    out(dim(`  grant one at this terminal: ${bold("oguri runner grant <name>")}`));
  }
  return 0;
}

/** `oguri runner request <name> "<why>" [--task <id>] [--room <id>]` — anyone may ask. */
async function runnerRequest(ctx: Ctx): Promise<number> {
  const name = ctx.positionals[2];
  const reason = ctx.positionals.slice(3).join(" ");
  if (name === undefined || reason.trim() === "") {
    usage('runner request needs a runner name and why: oguri runner request <name> "<why>"');
  }
  const taskId = str(ctx, "task");
  if (taskId !== undefined && !isUlid(taskId)) usage("--task must be a task id");
  const room = str(ctx, "room");
  // A worker's run may ask only about its own work, as over MCP (ADR 0036).
  if (runOf() !== null) {
    await withBackend(ctx, async (backend) => {
      await backend.runScope?.assertRequest({ taskId, room });
      return 0;
    });
  }
  const { request, duplicate } = await store(ctx).request({
    runner: name,
    by: ctx.config.agent.id,
    via: "cli",
    reason,
    ...(taskId === undefined ? {} : { taskId }),
    ...(room === undefined ? {} : { room }),
  });
  if (bool(ctx, "json")) json({ request, duplicate, granted: false });
  else {
    out(
      (duplicate ? dim("already asked") : green("✓ asked")) +
        dim(` for runner '${name}' · nothing is granted until a person runs oguri runner grant`),
    );
  }
  return 0;
}
