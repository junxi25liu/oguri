import { parseArgs } from "node:util";

import { Layout, describeError } from "@oguri/core";

import { cmdAgent, cmdAgents, cmdProfile } from "./commands/agents.ts";
import { cmdApprovals, cmdPolicy } from "./commands/approvals.ts";
import { cmdClaim, cmdClaims } from "./commands/claims.ts";
import { cmdChat } from "./commands/chat.ts";
import { cmdDaemon } from "./commands/daemon.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdHandshake } from "./commands/handshake.ts";
import { cmdInbox } from "./commands/inbox.ts";
import { cmdIntake } from "./commands/intake.ts";
import { cmdBig, cmdSmall, cmdSuperagent } from "./commands/superagent.ts";
import { cmdInit, cmdSetup, cmdUninstall } from "./commands/install.ts";
import { cmdMachine, cmdMachines, cmdPeers } from "./commands/machine.ts";
import { cmdAnswer, cmdDecide, cmdSend } from "./commands/messaging.ts";
import { cmdNetwork, cmdProject } from "./commands/network.ts";
import { cmdNotify } from "./commands/notify.ts";
import { cmdPlan } from "./commands/plan.ts";
import { cmdPresence } from "./commands/presence.ts";
import {
  cmdDecisions,
  cmdHistory,
  cmdMentions,
  cmdRead,
  cmdReceipts,
  cmdSearch,
  cmdTrace,
} from "./commands/reading.ts";
import { cmdReview } from "./commands/review.ts";
import { cmdRoom } from "./commands/room.ts";
import { cmdRunner } from "./commands/runner-presets.ts";
import { cmdSeal } from "./commands/seal.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdSync } from "./commands/sync.ts";
import { cmdTask } from "./commands/task.ts";
import { cmdTeam } from "./commands/team.ts";
import { cmdWatch } from "./commands/watch.ts";
import { cmdWeb } from "./commands/web.ts";
import { cmdWorker } from "./commands/worker.ts";
import { type Ctx, bool } from "./context.ts";
import { helpText } from "./help.ts";
import { IDENTITY_NEUTRAL_COMMANDS, loadOrEmpty, resolveIdentity } from "./identity.ts";
import { OPTIONS } from "./options.ts";
import { errline, out, red } from "./output.ts";
import { reportError } from "./report-error.ts";

export const VERSION = "1.0.5";

type Handler = (ctx: Ctx) => Promise<number>;

/**
 * Every command the CLI knows, by the word the user types. `send` and `ask`
 * share an implementation and differ only in whether a reply is expected.
 */
const COMMANDS: Readonly<Record<string, Handler>> = {
  init: cmdInit,
  setup: cmdSetup,
  uninstall: cmdUninstall,
  agent: cmdAgent,
  room: cmdRoom,
  answer: cmdAnswer,
  decide: cmdDecide,
  decisions: cmdDecisions,
  review: cmdReview,
  plan: cmdPlan,
  task: cmdTask,
  read: cmdRead,
  history: cmdHistory,
  search: cmdSearch,
  inbox: cmdInbox,
  handshake: cmdHandshake,
  watch: cmdWatch,
  worker: cmdWorker,
  runner: cmdRunner,
  intake: cmdIntake,
  superagent: cmdSuperagent,
  big: cmdBig,
  small: cmdSmall,
  chat: cmdChat,
  notify: cmdNotify,
  web: cmdWeb,
  network: cmdNetwork,
  project: cmdProject,
  trace: cmdTrace,
  receipts: cmdReceipts,
  mentions: cmdMentions,
  sync: cmdSync,
  seal: cmdSeal,
  status: cmdStatus,
  agents: cmdAgents,
  machine: cmdMachine,
  machines: cmdMachines,
  team: cmdTeam,
  peers: cmdPeers,
  profile: cmdProfile,
  presence: cmdPresence,
  claim: cmdClaim,
  claims: cmdClaims,
  policy: cmdPolicy,
  approvals: cmdApprovals,
  daemon: cmdDaemon,
  doctor: cmdDoctor,
  send: (ctx) => cmdSend(ctx, false),
  ask: (ctx) => cmdSend(ctx, true),
  mcp: runMcp,
};

async function runMcp(ctx: Ctx): Promise<number> {
  const { runStdioServer } = await import("@oguri/mcp");
  const network = typeof ctx.values["network"] === "string" ? ctx.values["network"] : undefined;
  await runStdioServer({
    ...(network === undefined ? {} : { network }),
    ...(bool(ctx, "direct") ? { direct: true } : {}),
  });
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    errline(red(`error: ${describeError(error)}`));
    errline("Run 'oguri --help' for usage.");
    return 2;
  }

  const layout = new Layout();
  const ctx: Ctx = {
    layout,
    config: await loadOrEmpty(layout),
    values: parsed.values as Record<string, unknown>,
    positionals: parsed.positionals,
  };

  if (bool(ctx, "version")) {
    out(VERSION);
    return 0;
  }
  const command = ctx.positionals[0];
  if (command === undefined || bool(ctx, "help") || command === "help") {
    process.stdout.write(helpText(VERSION));
    return command === undefined && !bool(ctx, "help") ? 2 : 0;
  }

  try {
    // Settle WHO this invocation is before it can write anything. `init`,
    // `agent`, and `setup` are excluded because they create and point at
    // identities — re-homing them would make provisioning impossible.
    if (!IDENTITY_NEUTRAL_COMMANDS.has(command)) {
      const resolved = await resolveIdentity(ctx, command);
      ctx.layout = resolved.layout;
      ctx.config = resolved.config;
    }

    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (handler === undefined) {
      errline(red(`error: unknown command '${command}'`));
      errline("Run 'oguri --help' for usage.");
      return 2;
    }
    return await handler(ctx);
  } catch (error) {
    return reportError(error);
  }
}
