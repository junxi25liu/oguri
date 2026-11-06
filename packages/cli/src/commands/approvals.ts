import {
  type ApprovalRecord,
  effectiveConcurrency,
  loadLocalPolicy,
  policyTemplate,
  redactPolicy,
} from "@oguri/core";
import { assertRoomId } from "@oguri/protocol";
import { ago, bold, cyan, dim, errline, green, json, out, red, yellow } from "../output.ts";

import { type Ctx, bool, usage } from "../context.ts";
import { pathExists } from "../identity.ts";
import { withBackend } from "../with-backend.ts";

/**
 * Record that a person approved this agent taking on delegated work.
 *
 * CLI only, and deliberately absent from the MCP tool surface: an agent able to
 * approve its own inbound work is a gate that gates nothing. Same reasoning as
 * the `--as-human` relay in ADR 0012 — this asserts a person agreed, it does
 * not prove one did, and the assertion is at least made at a terminal.
 */
export async function cmdApprove(ctx: Ctx, kind: "task" | "review"): Promise<number> {
  const room = ctx.positionals[2];
  const id = ctx.positionals[3];
  if (room === undefined || id === undefined) {
    usage(`${kind} approve needs <room> <${kind}-id> [note]`);
  }
  assertRoomId(room);
  const note = ctx.positionals.slice(4).join(" ");

  return await withBackend(ctx, async (be) => {
    if (bool(ctx, "revoke")) {
      const { revoked } = await be.call<{ revoked: boolean }>("approveRevoke", { kind, id });
      if (bool(ctx, "json")) json({ kind, id, revoked });
      else out(revoked ? green(`✓ approval withdrawn for ${id}`) : dim(`${id} was not approved`));
      return 0;
    }
    const record = await be.call<ApprovalRecord>("approve", {
      kind,
      room,
      id,
      ...(note === "" ? {} : { note }),
    });
    if (bool(ctx, "json")) json(record);
    else {
      out(green(`✓ approved locally`) + dim(` ${kind} ${id}`));
      out(dim("  recorded on this machine only — never published to the network"));
      out(`  ${bold(`oguri ${kind} ${kind === "task" ? "claim" : "update"} ${room} ${id} …`)}`);
    }
    return 0;
  });
}

export async function cmdApprovals(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const records = await be.call<ApprovalRecord[]>("approvals");
    if (bool(ctx, "json")) {
      json(records);
      return 0;
    }
    if (records.length === 0) {
      out(dim("nothing approved on this machine"));
      return 0;
    }
    for (const record of records) {
      out(
        `${cyan(record.kind.padEnd(7))} ${bold(record.id)} ${dim(`#${record.room} · ${ago(record.approvedAt)}`)}`,
      );
      if (record.note !== undefined) out(dim(`  ${record.note}`));
    }
    return 0;
  });
}

/** Show the effective machine-local policy, and where each value came from. */
export async function cmdPolicy(ctx: Ctx): Promise<number> {
  const path = ctx.layout.policyPath;
  if (bool(ctx, "init")) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    if (await pathExists(path)) {
      errline(red(`error: ${path} already exists`));
      errline(dim("  edit it directly; oguri never rewrites this file"));
      return 1;
    }
    // The home may not exist yet: setting rules before joining a network is a
    // reasonable first move, and this command must work on a fresh machine.
    await mkdir(ctx.layout.root, { recursive: true });
    await writeFile(path, policyTemplate(), { encoding: "utf8", mode: 0o600 });
    out(green("✓ wrote a commented policy file") + dim(` ${path}`));
    out(dim("  oguri reads it and never rewrites it, so your comments survive"));
    return 0;
  }

  // Read straight from disk rather than through the backend: this file is
  // machine-local, so asking a daemon about it would be indirection — and it
  // would make `oguri policy` fail on a machine that has not joined a network
  // yet, which is exactly when someone wants to set their rules.
  const resolved = await loadLocalPolicy(ctx.layout);
  if (bool(ctx, "json")) {
    // Push channel URLs and tokens (ADR 0028) and the intake app secret
    // (ADR 0030) are credentials; never print them.
    json({ ...redactPolicy(resolved), path });
    return 0;
  }
  const approvals = resolved.policy.approvals;
  out(`${bold("approvals")}`);
  out(`  inboundWork  ${cyan(approvals.inboundWork)}`);
  out(
    `  localAgents  ${approvals.localAgents.length === 0 ? dim("none — every other agent is remote") : approvals.localAgents.join(", ")}`,
  );
  out();
  const worker = resolved.policy.worker;
  out(`${bold("worker")}`);
  out(
    `  enabled      ${worker.enabled ? yellow(`yes — runners: ${Object.keys(worker.runners).join(", ")}`) : dim("no — oguri never starts an agent")}`,
  );
  if (worker.enabled) {
    const source = resolved.policy.superagent.small.enabled
      ? `superagent.small.maxWorkers; worker.concurrency is ${String(worker.concurrency)}`
      : "worker.concurrency";
    out(
      `  limits       ${String(effectiveConcurrency(resolved.policy))} at once ${dim(`(${source})`)}, ${String(worker.maxPerHour)}/hour, ${String(worker.timeoutMinutes)} min ${dim("(this spends your plan)")}`,
    );
    out(
      `  trusted      ${worker.trustedRequesters.length === 0 ? dim("none — remote tasks wait for approval") : worker.trustedRequesters.join(", ")}`,
    );
  }
  out();
  const channels = resolved.policy.notifications.channels;
  out(`${bold("notifications")}`);
  out(
    `  channels     ${channels.length === 0 ? dim("none — nothing is pushed") : channels.map((c) => `${c.name} (${c.format})`).join(", ")}`,
  );
  out();
  const intake = resolved.policy.intake;
  out(`${bold("intake")}`);
  out(
    `  enabled      ${intake.enabled ? yellow("yes — chat requests become tasks here") : dim("no — no chat is read on this machine")}`,
  );
  if (intake.feishu !== undefined) {
    out(`  feishu app   ${intake.feishu.appId} ${dim("(secret not shown)")}`);
    out(
      `  allowed      ${intake.feishu.allowed.length === 0 ? dim("nobody — only chats with anyone: true") : intake.feishu.allowed.join(", ")}`,
    );
    for (const chat of intake.feishu.chats) {
      const target = chat.target === undefined ? "" : dim(` for ${chat.target}`);
      out(`  chat         ${chat.id} → ${chat.room}${target}${chat.anyone ? dim(" anyone") : ""}`);
    }
  }
  out();
  if (resolved.sources.length === 0) {
    out(dim("all values are defaults; no policy file is present"));
    out(`write a commented one:  ${bold("oguri policy --init")}`);
  } else {
    out(dim(`from: ${resolved.sources.join(", ")}`));
  }
  return 0;
}
