import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Layout, loadConfig, normalizeAgentTool, saveConfig } from "@oguri/core";
import { assertAgentId } from "@oguri/protocol";
import { bold, dim, errline, green, json, out, red, yellow } from "../output.ts";

import { type Ctx, bool, list, str, usage } from "../context.ts";
import { pathExists, publishIdentityMetadata, registeredMachine } from "../identity.ts";
import { withBackend } from "../with-backend.ts";

export async function cmdAgents(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const cards = await be.call<
      {
        id: string;
        human: { name: string; timezone: string };
        tool: string;
        role?: string;
        subscriptions?: string[];
      }[]
    >("agents");
    if (bool(ctx, "json")) {
      json(cards);
      return 0;
    }
    if (cards.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const c of cards) {
      out(
        `${bold(c.id.padEnd(20))} ${c.role ?? dim("role not published")} ${dim(
          `· ${c.human.name} · ${c.human.timezone} · ${c.tool}`,
        )}`,
      );
      // Which rooms they follow decides whether a mention reaches them at all.
      out(
        c.subscriptions === undefined
          ? dim("  rooms not published (older oguri)")
          : dim(`  rooms: ${c.subscriptions.length === 0 ? "none" : c.subscriptions.join(", ")}`),
      );
    }
    return 0;
  });
}

interface CliAgentProfile {
  id: string;
  updatedAt: string;
  role: string;
  mission: string;
  currentFocus: string;
  environment: { client: string; platform: string; architecture: string; workspace?: string };
  capabilities: string[];
  responsibilities: string[];
  constraints: string[];
  canHelpWith: string[];
}

function optionalList(ctx: Ctx, key: string): string[] | undefined {
  return ctx.values[key] === undefined ? undefined : list(ctx, key);
}

function renderProfile(profile: CliAgentProfile): void {
  out(`${bold(profile.id)} — ${profile.role}`);
  out(dim(`updated ${profile.updatedAt}`));
  out(`mission       ${profile.mission}`);
  out(`current focus ${profile.currentFocus}`);
  out(
    `environment   ${profile.environment.client} · ${profile.environment.platform}/${profile.environment.architecture}${
      profile.environment.workspace === undefined ? "" : ` · ${profile.environment.workspace}`
    }`,
  );
  for (const [label, values] of [
    ["capabilities", profile.capabilities],
    ["responsibilities", profile.responsibilities],
    ["constraints", profile.constraints],
    ["can help with", profile.canHelpWith],
  ] as const) {
    out(`${label.padEnd(14)} ${values.length === 0 ? dim("none declared") : values.join("; ")}`);
  }
}

export async function cmdProfile(ctx: Ctx): Promise<number> {
  const action = ctx.positionals[1] === "update" ? "update" : "show";
  return await withBackend(ctx, async (be) => {
    if (action === "show") {
      const explicitShow = ctx.positionals[1] === "show";
      const agent = explicitShow ? ctx.positionals[2] : ctx.positionals[1];
      if (ctx.positionals.length > (explicitShow ? 3 : 2)) {
        usage("profile show accepts at most one agent id");
      }
      const profile = await be.call<CliAgentProfile | null>(
        "profileGet",
        agent === undefined ? {} : { agent },
      );
      if (bool(ctx, "json")) {
        json(profile);
        return 0;
      }
      if (profile === null) {
        out(dim(agent === undefined ? "profile not published" : `no profile for ${agent}`));
        return 0;
      }
      renderProfile(profile);
      return 0;
    }

    if (ctx.positionals.length > 2) usage("profile update accepts options, not positional text");
    const capabilities = optionalList(ctx, "capability");
    const responsibilities = optionalList(ctx, "responsibility");
    const constraints = optionalList(ctx, "constraint");
    const canHelpWith = optionalList(ctx, "help-with");
    const result = await be.call<{ published: boolean; profile: CliAgentProfile }>(
      "profileUpdate",
      {
        input: {
          ...(str(ctx, "role") === undefined ? {} : { role: str(ctx, "role") }),
          ...(str(ctx, "mission") === undefined ? {} : { mission: str(ctx, "mission") }),
          ...(str(ctx, "focus") === undefined ? {} : { currentFocus: str(ctx, "focus") }),
          ...(str(ctx, "workspace") === undefined ? {} : { workspace: str(ctx, "workspace") }),
          ...(capabilities === undefined ? {} : { capabilities }),
          ...(responsibilities === undefined ? {} : { responsibilities }),
          ...(constraints === undefined ? {} : { constraints }),
          ...(canHelpWith === undefined ? {} : { canHelpWith }),
        },
      },
    );
    if (bool(ctx, "json")) {
      json(result);
      return 0;
    }
    out(result.published ? green("✓ agent profile published") : dim("profile unchanged"));
    renderProfile(result.profile);
    return 0;
  });
}

/**
 * Provision and inspect the agent identities that live on this machine.
 *
 * Several agents on one machine is the ordinary case, not an exotic one: Claude
 * and Codex side by side, or two sessions of the same tool. They are separate
 * participants and each needs its own identity, because routing never returns a
 * message to its own author — so two tools sharing one agent id cannot reach
 * each other at all, and the failure is silent. Every message simply never
 * arrives.
 *
 * Each identity is a whole `OGURI_HOME` of its own under `agents/<id>/`.
 */
export async function cmdAgent(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";
  const agentsRoot = ctx.layout.agentsDir;

  const provisioned = async (): Promise<
    { id: string; tool: string | null; home: string; network: string | null }[]
  > => {
    let entries: string[];
    try {
      entries = (await readdir(agentsRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    const rows: { id: string; tool: string | null; home: string; network: string | null }[] = [];
    for (const id of entries) {
      const home = join(agentsRoot, id);
      const config = await loadConfig(new Layout(home).configPath).catch(() => null);
      rows.push({
        id,
        tool: config?.agent.tool ?? null,
        home,
        network: config?.defaultNetwork ?? null,
      });
    }
    return rows;
  };

  switch (sub) {
    case "add": {
      const id = ctx.positionals[2];
      if (id === undefined) usage("agent add needs an id: oguri agent add <agent-id> --repo <url>");
      assertAgentId(id);

      const home = ctx.layout.agentHomeDir(id);
      if (await pathExists(join(home, "config.yaml"))) {
        errline(red(`error: agent '${id}' already exists at ${home}`));
        errline(dim("  Use a distinct id for a second instance, e.g. " + `${id}-2`));
        return 1;
      }

      // `init` is the one command that must run inside the new home, so it is
      // re-entered as a child with OGURI_HOME set rather than reimplemented.
      const remote = str(ctx, "repo");
      if (remote === undefined) {
        usage("agent add needs a transport: oguri agent add <agent-id> --repo <url-or-path>");
      }
      const network = str(ctx, "network");
      const tool = normalizeAgentTool(str(ctx, "tool") ?? "cli");
      const machine = await registeredMachine(ctx.layout, ctx.config.agent.machine);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const self = process.argv[1];
      const argv = [
        ...(self === undefined ? [] : [self]),
        "init",
        "--repo",
        remote,
        "--agent",
        id,
        "--tool",
        tool,
        ...(network === undefined ? [] : ["--network", network]),
      ];
      try {
        await promisify(execFile)(process.execPath, argv, {
          // The parent may carry an explicit machine rename. Propagating it at
          // birth keeps the new card in the same machine group immediately.
          env: {
            ...process.env,
            OGURI_HOME: home,
            OGURI_MACHINE_ID: machine.id,
          },
        });
      } catch (error) {
        const e = error as { stderr?: string; stdout?: string };
        errline(red(`error: could not initialise agent '${id}'`));
        errline((e.stderr ?? e.stdout ?? String(error)).trim());
        return 1;
      }

      // Close the only meaningful provisioning race: a simultaneous
      // `machine set` may land after the child read the marker but before its
      // config became visible to the machine-wide scan.
      const currentMachine = await registeredMachine(ctx.layout, machine);
      if (currentMachine.id !== machine.id || currentMachine.label !== machine.label) {
        const layout = new Layout(home);
        const config = await loadConfig(layout.configPath);
        if (config !== null) {
          config.agent.machine = currentMachine;
          await saveConfig(layout.configPath, config);
          const failures = await publishIdentityMetadata(layout, config);
          if (failures.length > 0) {
            errline(yellow("warning: the new agent is local, but its corrected card is queued"));
            for (const failure of failures) errline(dim(`  ${failure}`));
          }
        }
      }

      if (bool(ctx, "json")) {
        json({ id, tool, home, network: network ?? null, remote });
        return 0;
      }
      out(green(`✓ agent ${bold(id)}`) + dim(` → ${home}`));
      out();
      out("point a tool at it:");
      out(`  ${bold(`oguri setup <tool> --agent ${id}`)}`);
      out("or run one command as this agent:");
      out(`  ${bold(`OGURI_HOME=${home} oguri <command>`)}`);
      return 0;
    }

    case "list": {
      const rows = await provisioned();
      if (bool(ctx, "json")) {
        json(rows);
        return 0;
      }
      if (rows.length === 0) {
        out(dim("no per-agent homes on this machine"));
        out();
        out(dim("this machine's single shared identity is in " + ctx.layout.configPath));
        out(dim("add a second agent with: oguri agent add <id> --repo <transport>"));
        return 0;
      }
      for (const row of rows) {
        out(
          `${bold(row.id.padEnd(24))} ${dim(`${row.tool ?? "unknown tool"} · ${row.network ?? "unconfigured"} · ${row.home}`)}`,
        );
      }
      return 0;
    }

    case "path": {
      const id = ctx.positionals[2];
      if (id === undefined) usage("agent path needs an id: oguri agent path <agent-id>");
      assertAgentId(id);
      // Bare, on stdout, so it composes: OGURI_HOME=$(oguri agent path x) oguri inbox
      out(ctx.layout.agentHomeDir(id));
      return 0;
    }

    default:
      usage(`unknown 'agent' subcommand: ${sub}`);
  }
}
