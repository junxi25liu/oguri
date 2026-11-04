/**
 * `oguri team` — the whole team on one screen.
 *
 * The three questions a person asks before handing out work are "who is
 * there", "what can they take", and "what will this computer run" — and before
 * this command they lived in `machines`, `agents`, `profile`, `worker status`
 * and `superagent status`, four of which need a different command. Reading
 * them together is also the only view where a machine with no live agent and a
 * runner nobody uses are visible in the same glance.
 *
 * It is a read: nothing here writes presence or claims work.
 */

import { loadLocalPolicy } from "@oguri/core";

import { type Ctx, bool } from "../context.ts";
import { bold, cyan, dim, green, json, out, yellow } from "../output.ts";
import { withBackend } from "../with-backend.ts";

interface TeamAgent {
  id: string;
  tool: string;
  human: string;
  status: string;
  role: string | null;
  focus: string | null;
  capabilities: string[];
}

interface TeamMachine {
  id: string | null;
  label: string | null;
  self: boolean;
  contested: boolean;
  live: number;
  agents: TeamAgent[];
}

function mark(status: string): string {
  if (status === "live") return green("●");
  if (status === "stale") return yellow("◐");
  return dim("○");
}

/** Capabilities are free text, so trim the tail rather than let one long profile wrap the screen. */
function capabilityText(capabilities: readonly string[]): string {
  if (capabilities.length === 0) return dim("none declared");
  const shown = capabilities.slice(0, 6).join(", ");
  return capabilities.length > 6 ? `${shown} ${dim(`+${String(capabilities.length - 6)}`)}` : shown;
}

export async function cmdTeam(ctx: Ctx): Promise<number> {
  const { policy } = await loadLocalPolicy(ctx.layout);

  return await withBackend(ctx, async (be) => {
    // No `.catch(() => [])` here, unlike `plan`: an unreachable remote would
    // otherwise render as an empty team, which is the one reading a person
    // must not mistake for "nobody is there".
    const machines = await be.call<TeamMachine[]>("machines");
    const runners = Object.keys(policy.worker.runners);
    const superagent = {
      big: policy.superagent.big.enabled,
      small: policy.superagent.small.enabled,
      maxWorkers: policy.superagent.small.maxWorkers,
      ...(policy.superagent.big.runner === undefined
        ? {}
        : { bigRunner: policy.superagent.big.runner }),
      ...(policy.superagent.small.runner === undefined
        ? {}
        : { smallRunner: policy.superagent.small.runner }),
    };

    if (bool(ctx, "json")) {
      json({ machines, runners, superagent });
      return 0;
    }

    const totalAgents = machines.reduce((sum, machine) => sum + machine.agents.length, 0);
    const liveAgents = machines.reduce((sum, machine) => sum + machine.live, 0);
    out(
      `${bold("team")} ${dim(`· ${String(machines.length)} machine(s), ${String(totalAgents)} agent(s), ${String(liveAgents)} live`)}`,
    );

    if (machines.length === 0) {
      out("");
      out(dim("no agents registered yet — 'oguri agent add <id> --repo <url>' on each computer"));
    }

    for (const machine of machines) {
      const name =
        machine.id === null ? dim("(machine not published)") : bold(`machine:${machine.id}`);
      const label =
        machine.label === null || machine.label === machine.id ? "" : dim(` · ${machine.label}`);
      out("");
      out(`${name}${label}${machine.self ? green("  ← this computer") : ""}`);
      if (machine.contested) {
        out(yellow("  several people claim this id") + dim(" · oguri machine set <id>"));
      }
      if (machine.agents.length === 0) {
        out(dim("  no agents published"));
        continue;
      }
      for (const agent of machine.agents) {
        out(
          `  ${mark(agent.status)} ${bold(agent.id.padEnd(20))} ` +
            `${dim(agent.tool)}${agent.role === null ? "" : ` · ${agent.role}`}`,
        );
        const context = [
          // A daemon older than this CLI sends no capabilities.
          `capabilities: ${capabilityText(agent.capabilities ?? [])}`,
          agent.focus === null ? null : `focus: ${agent.focus}`,
        ].filter((part): part is string => part !== null);
        out(dim(`    ${context.join(" · ")}`));
      }
    }

    out("");
    out(dim("this machine"));
    out(
      `  runners      ${
        runners.length === 0 ? dim("none — the worker can start nothing here") : runners.join(", ")
      }`,
    );
    out(
      `  superagent   ${
        superagent.big || superagent.small
          ? [superagent.big ? "big" : null, superagent.small ? "small" : null]
              .filter((part): part is string => part !== null)
              .join(" + ") +
            (superagent.bigRunner === undefined
              ? ""
              : dim(` · thinks with ${superagent.bigRunner}`)) +
            (superagent.smallRunner === undefined
              ? ""
              : dim(` · small thinks with ${superagent.smallRunner}`))
          : dim("off")
      }`,
    );
    out(
      `  max workers  ${cyan(String(superagent.maxWorkers))} at once per this machine's small superagent`,
    );
    out("");
    out(dim("profiles carry capabilities:  oguri profile update --capability <name>"));
    return 0;
  });
}
