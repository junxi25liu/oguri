import { join } from "node:path";
import { Layout, Network, loadConfig, saveConfig } from "@oguri/core";
import { assertAgentId, slugify } from "@oguri/protocol";
import { bold, cyan, dim, errline, green, json, out, red, yellow } from "../output.ts";
import { SETUP_TARGETS, type SetupTarget, setupTool, uninstallTool } from "../setup.ts";

import { type Ctx, bool, str, usage } from "../context.ts";
import {
  pathExists,
  publishIdentityMetadata,
  registeredMachine,
  setIdentityTool,
} from "../identity.ts";

export async function cmdInit(ctx: Ctx): Promise<number> {
  const remote = str(ctx, "repo") ?? ctx.positionals[1];
  if (remote === undefined) usage("init needs a repository: oguri init --repo <url>");

  const networkId =
    str(ctx, "network") ??
    slugify(
      remote
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .pop() ?? "oguri",
    ) ??
    "oguri";

  const agentId = str(ctx, "agent");
  const agentTool = str(ctx, "tool");
  if (agentId !== undefined) {
    assertAgentId(agentId);
    ctx.config.agent.id = agentId;
  }
  if (agentTool !== undefined) setIdentityTool(ctx.config, agentTool);
  ctx.config.agent.machine = await registeredMachine(ctx.layout, ctx.config.agent.machine);

  out(`Connecting to ${bold(remote)} as ${bold(ctx.config.agent.id)}…`);
  const { network, createdNetwork } = await Network.init({
    layout: ctx.layout,
    networkId,
    remote,
    identity: ctx.config.agent,
  });

  try {
    ctx.config.networks[networkId] = network.config;
    ctx.config.defaultNetwork ??= networkId;
    await saveConfig(ctx.layout.configPath, ctx.config);

    const rooms = await network.listRooms().catch(() => []);
    out(green(createdNetwork ? "✓ initialised a new network" : "✓ joined existing network"));
    // "joined existing network" next to "no rooms yet" reads like a failed
    // sync. Say which it is: an empty network is a fact about the network, not
    // a symptom.
    if (!createdNetwork) {
      out(
        rooms.length === 0
          ? dim("  it exists but is empty — nobody has created a room yet")
          : dim(`  ${String(rooms.length)} room(s) already here — oguri room list`),
      );
    }
    out(`✓ agent card published as ${ctx.config.agent.id}`);
    out(`✓ config written to ${ctx.layout.configPath}`);
    // Adding a network does not switch to it — silently moving what every bare
    // command means is worse than saying so. But NOT saying so is how the next
    // `oguri room create` lands on the old network and looks like a bug.
    if (ctx.config.defaultNetwork !== networkId) {
      out();
      out(
        yellow(`! commands still act on ${bold(ctx.config.defaultNetwork ?? "?")}`) +
          dim(` — this added ${networkId} without switching`),
      );
      out(`  ${cyan(`oguri network use ${networkId}`)}${dim("   · or --network on one command")}`);
    }
    out();
    // The card is published blank, and a blank card is the reason "who owns
    // auth?" gets no answer on a fresh network. Asking for it here — at the one
    // moment the user is already configuring — is what stops a directory of
    // empty entries from being the default state.
    out(bold("Say what you cover, or peers cannot route work to you:"));
    out(
      `  ${cyan(`oguri profile update --role '<what you do>' --responsibility '<repo you own>'`)}`,
    );
    out();
    out(
      `Next:  ${cyan("oguri room list")}   ${dim("·")}   ${cyan("oguri daemon start")}   ${dim("·")}   ${cyan("oguri setup claude-code")}`,
    );
    out(
      dim(
        `Someone may have written to you before you joined a room: ${"oguri mentions"} finds it.`,
      ),
    );
    return 0;
  } finally {
    network.close();
  }
}

export async function cmdSetup(ctx: Ctx): Promise<number> {
  const target = ctx.positionals[1] as SetupTarget | undefined;
  if (target === undefined || !SETUP_TARGETS.includes(target)) {
    usage(`setup needs a tool: ${SETUP_TARGETS.join(" | ")}`);
  }

  const agent = str(ctx, "agent");
  if (agent !== undefined) assertAgentId(agent);
  const explicitHome = process.env["OGURI_HOME"] !== undefined;
  const agentHome =
    agent === undefined
      ? explicitHome
        ? ctx.layout.root
        : undefined
      : explicitHome && ctx.config.agent.id === agent
        ? ctx.layout.root
        : ctx.layout.agentHomeDir(agent);
  if (
    agent !== undefined &&
    agentHome !== undefined &&
    !(await pathExists(join(agentHome, "config.yaml")))
  ) {
    errline(red(`error: no agent '${agent ?? ""}' on this machine`));
    errline(dim(`  create it first: oguri agent add ${agent ?? "<id>"} --repo <transport>`));
    return 1;
  }

  const result = await setupTool(target, agentHome === undefined ? {} : { agentHome });
  const identityLayout = new Layout(agentHome ?? ctx.layout.root);
  const identityConfig = await loadConfig(identityLayout.configPath);
  if (identityConfig !== null) {
    const changed = setIdentityTool(identityConfig, target);
    if (changed) await saveConfig(identityLayout.configPath, identityConfig);
    result.changes.push({
      path: identityLayout.configPath,
      action: changed ? "updated" : "unchanged",
      what: "agent tool identity",
    });
    const failures = await publishIdentityMetadata(identityLayout, identityConfig);
    if (failures.length > 0) {
      result.warnings.push(
        "Tool identity is correct locally, but some remote cards/profiles could not be refreshed yet: " +
          failures.join("; "),
      );
    }
  }
  if (bool(ctx, "json")) {
    json(result);
    return 0;
  }
  out(`${bold(target)}`);
  for (const change of result.changes) {
    const mark = change.action === "unchanged" ? dim("=") : green("✓");
    out(`${mark} ${change.what} ${dim(`→ ${change.path} (${change.action})`)}`);
  }
  out();
  // Before the notes, and not dimmed: this one is the difference between a
  // working link and two agents talking past each other in total silence.
  for (const warning of result.warnings) {
    out(`${yellow("!")} ${warning}`);
    out();
  }
  for (const note of result.notes) out(dim(`  ${note}`));
  return 0;
}

export async function cmdUninstall(ctx: Ctx): Promise<number> {
  const target = ctx.positionals[1] as SetupTarget | undefined;
  if (target === undefined || !SETUP_TARGETS.includes(target)) {
    usage(`uninstall needs a tool: ${SETUP_TARGETS.join(" | ")}`);
  }

  const result = await uninstallTool(target);
  if (bool(ctx, "json")) {
    json(result);
    return 0;
  }
  out(`${bold(target)}`);
  for (const change of result.changes) {
    const mark = change.action === "unchanged" ? dim("=") : green("✓");
    out(`${mark} ${change.what} ${dim(`→ ${change.path} (${change.action})`)}`);
  }
  out();
  for (const note of result.notes) out(dim(`  ${note}`));
  return 0;
}
