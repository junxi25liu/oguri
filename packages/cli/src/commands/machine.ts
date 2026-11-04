import { loadConfig, saveConfig } from "@oguri/core";
import { assertMachineId } from "@oguri/protocol";
import { bold, dim, green, json, out, yellow } from "../output.ts";

import { type Ctx, bool, usage } from "../context.ts";
import {
  configuredAgentLayouts,
  publishIdentityMetadata,
  writeRegisteredMachine,
} from "../identity.ts";
import { withBackend } from "../with-backend.ts";

interface MachineAgentJson {
  id: string;
  tool: string;
  human: string;
  status: string;
  lastSeen: string;
  lastActivity: string | null;
  sessions: number;
  rooms: string[] | null;
  role: string | null;
  focus: string | null;
  workspace: string | null;
}

interface MachineJson {
  id: string | null;
  label: string | null;
  humans: string[];
  contested: boolean;
  self: boolean;
  live: number;
  agents: MachineAgentJson[];
}

function presenceMark(status: string): string {
  if (status === "live") return green("●");
  if (status === "stale") return yellow("◐");
  return dim("○");
}

function renderMachineAgent(agent: MachineAgentJson, indent: string): void {
  out(
    `${indent}${presenceMark(agent.status)} ${bold(agent.id.padEnd(20))} ` +
      `${agent.role ?? dim("role not published")} ${dim(`· ${agent.tool}`)}`,
  );
  const context = [
    agent.focus === null ? null : `focus: ${agent.focus}`,
    agent.workspace === null ? null : `workspace: ${agent.workspace}`,
    agent.sessions > 0 ? `${String(agent.sessions)} session(s)` : null,
  ].filter((part): part is string => part !== null);
  if (context.length > 0) out(dim(`${indent}  ${context.join(" · ")}`));
  out(
    agent.rooms === null
      ? dim(`${indent}  rooms not published (older oguri)`)
      : dim(`${indent}  rooms: ${agent.rooms.length === 0 ? "none" : agent.rooms.join(", ")}`),
  );
}

/**
 * This computer's identity, and the agents sharing it.
 *
 * `machine set` exists for exactly one situation, and it is worth naming: two
 * laptops both called `macbook-pro` derive the same id, and every routing
 * decision downstream then treats them as one box. Nothing on the wire can
 * detect that reliably, so the fix is a person renaming one of them.
 */
export async function cmdMachine(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1];

  if (sub === "set") {
    const id = ctx.positionals[2];
    if (id === undefined) usage("machine set needs an id: oguri machine set <id>");
    assertMachineId(id);
    const label = ctx.config.agent.machine.label;
    const agents: string[] = [];
    const publishFailures: string[] = [];

    await writeRegisteredMachine(ctx.layout, { id, label });

    // Machine identity belongs to the computer, not whichever tool happened to
    // run this command. Update every locally provisioned home before publishing
    // any card, so a partial remote failure can recover from consistent local
    // state on the next agent connection.
    for (const layout of await configuredAgentLayouts(ctx.layout)) {
      const config =
        layout.root === ctx.layout.root ? ctx.config : await loadConfig(layout.configPath);
      if (config === null) continue;
      config.agent.machine = { id, label };
      await saveConfig(layout.configPath, config);
      agents.push(config.agent.id);
      publishFailures.push(...(await publishIdentityMetadata(layout, config)));
    }

    if (bool(ctx, "json")) {
      json({
        machine: { id, label },
        agents: agents.sort(),
        published: publishFailures.length === 0,
        publishFailures,
      });
      return 0;
    }
    out(green(`✓ this computer is now ${id}`));
    out(
      dim(
        `  updated ${String(agents.length)} local agent identity(s): ${agents.sort().join(", ")}`,
      ),
    );
    if (publishFailures.length === 0) {
      out(dim("  republished every configured agent card and profile"));
    } else {
      out(yellow("  local identities are consistent; some remote metadata is queued for retry:"));
      for (const failure of publishFailures) out(dim(`  ${failure}`));
    }
    return 0;
  }

  if (sub === "room") {
    return await withBackend(ctx, async (be) => {
      const result = await be.call<{ room: string; created: boolean; joined: boolean }>(
        "machineRoom",
      );
      if (bool(ctx, "json")) return (json(result), 0);
      out(
        green(`✓ #${result.room}`) +
          dim(
            result.created
              ? " created and joined"
              : result.joined
                ? " already existed — joined"
                : " already joined",
          ),
      );
      out(dim("  the agents on this computer share it; anything sent here reaches them all"));
      return 0;
    });
  }

  if (sub !== undefined)
    usage("unknown machine subcommand; use 'machine', 'machine set', or 'machine room'");

  return await withBackend(ctx, async (be) => {
    const machine = ctx.config.agent.machine;
    const peers = await be.call<MachineAgentJson[]>("peers");
    if (bool(ctx, "json")) return (json({ ...machine, peers }), 0);

    out(`${bold(machine.id)} ${dim(`· ${machine.label}`)}`);
    out(dim(`  this agent: ${ctx.config.agent.id}`));
    if (peers.length === 0) {
      out(dim("  no other agent has registered on this computer"));
      out(dim("  add one with: oguri agent add <id> --repo <url>"));
      return 0;
    }
    out("");
    out(dim(`  ${String(peers.length)} peer(s) here:`));
    for (const peer of peers) renderMachineAgent(peer, "  ");
    return 0;
  });
}

/**
 * The other agents on this computer.
 *
 * Separate from `agents` because the answer is used differently: a co-located
 * peer shares the filesystem, so work can be handed to it without moving
 * anything, and its claims on a path or a build are the ones that actually
 * collide with this agent's.
 */
export async function cmdPeers(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const peers = await be.call<MachineAgentJson[]>("peers");
    if (bool(ctx, "json")) return (json(peers), 0);
    if (peers.length === 0) {
      out(dim(`no other agent has registered on ${ctx.config.agent.machine.id}`));
      return 0;
    }
    for (const peer of peers) renderMachineAgent(peer, "");
    return 0;
  });
}

/** The network grouped by computer rather than by agent id. */
export async function cmdMachines(ctx: Ctx): Promise<number> {
  return await withBackend(ctx, async (be) => {
    const machines = await be.call<MachineJson[]>("machines");
    if (bool(ctx, "json")) return (json(machines), 0);
    if (machines.length === 0) {
      out(dim("no agents registered"));
      return 0;
    }
    for (const machine of machines) {
      const name =
        machine.id === null ? dim("(machine not published)") : bold(`machine:${machine.id}`);
      const label =
        machine.label === null || machine.label === machine.id ? "" : ` · ${machine.label}`;
      out(
        `${name}${dim(label)} ${dim(
          `· ${machine.humans.join(", ")} · ${String(machine.agents.length)} agent(s), ` +
            `${String(machine.live)} live`,
        )}${machine.self ? green("  ← this computer") : ""}`,
      );
      if (machine.contested) {
        out(
          yellow("  several people claim this id") +
            dim(" — most likely two computers whose hostnames match."),
        );
        out(dim("  on the odd one out, run: oguri machine set <a-different-id>"));
      }
      if (machine.id === null) {
        out(dim("  these agents run an older oguri and publish no machine; they can still"));
        out(dim("  be addressed by agent id, but no machine:<id> mention will reach them"));
      }
      for (const agent of machine.agents) renderMachineAgent(agent, "  ");
      out("");
    }
    return 0;
  });
}
