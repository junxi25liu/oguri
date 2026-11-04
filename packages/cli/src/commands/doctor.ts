import { GitRunner, Network, Repo, isDefaultProfile } from "@oguri/core";
import { DaemonClient } from "@oguri/daemon";
import { conciseGitFailure, sshHostOf } from "../diagnostics.ts";
import { daemonEntryProblem } from "../daemon-cmd.ts";
import { dim, green, out, red, yellow } from "../output.ts";

import { type Ctx } from "../context.ts";
import { checkSuperagentDoctor } from "./doctor-superagent.ts";

/** Diagnose the predictable failures, each with a concrete fix. */
/**
 * Check that this agent has said what it is for.
 *
 * Reported by doctor rather than enforced at init, because a blank card breaks
 * nothing mechanically — it breaks the one question oguri exists to answer,
 * and it does it silently. An agent whose card says `expertise: []` is
 * unfindable: a peer asking "who owns auth?" gets nobody, routes to a human,
 * and concludes the directory is empty rather than unfilled.
 */
async function describeOwnCard(
  ctx: Ctx,
  ok: (m: string) => void,
  warn: (m: string, hint: string) => void,
): Promise<void> {
  for (const netConfig of Object.values(ctx.config.networks)) {
    const network = Network.open(ctx.layout, netConfig, ctx.config.agent);
    try {
      const self = (await network.listAgents()).find((card) => card.id === ctx.config.agent.id);
      const profile = await network.getAgentProfile().catch(() => null);
      // The default profile is boilerplate true of any agent, so a card that
      // still carries it has said nothing — and reporting that as healthy is
      // what let a whole network of blank entries look like a directory.
      const described =
        (self?.expertise.length ?? 0) > 0 ||
        (self?.speaksFor.length ?? 0) > 0 ||
        (profile !== null && !isDefaultProfile(profile, ctx.config.agent));
      if (described) {
        ok(`${netConfig.id}: this agent's card says what it is for`);
      } else {
        warn(
          `${netConfig.id}: this agent's card is blank — peers cannot tell what you cover`,
          "oguri's premise is 'ask the agent that owns that repo', and an empty card answers nobody. Fill it in:\n" +
            "  oguri profile update --role '<what you do>' --responsibility '<repo or domain you own>'",
        );
      }
    } catch {
      // A network that will not open is already reported by the checks above.
    } finally {
      network.close();
    }
  }
}

export async function cmdDoctor(ctx: Ctx): Promise<number> {
  let problems = 0;
  const ok = (m: string) => out(`${green("✓")} ${m}`);
  const warn = (m: string, hint: string) => {
    out(`${yellow("!")} ${m}`);
    out(dim(`  ${hint}`));
  };
  const bad = (m: string, fix: string) => {
    problems += 1;
    out(`${red("✗")} ${m}`);
    out(dim(`  fix: ${fix}`));
  };

  const runner = new GitRunner();
  try {
    const version = await new Repo(process.cwd(), runner).version();
    if (version.major > 2 || (version.major === 2 && version.minor >= 42)) {
      ok(`git ${version.major}.${version.minor}`);
    } else {
      bad(`git ${version.raw} is too old`, "oguri needs git 2.42+ (for 'worktree add --orphan')");
    }
  } catch {
    bad("git not found", "install git");
  }

  const networks = Object.keys(ctx.config.networks);
  if (networks.length === 0) {
    bad("no networks configured", "oguri init --repo <url>");
  } else {
    ok(`config at ${ctx.layout.configPath} (${String(networks.length)} network(s))`);
  }

  for (const netConfig of Object.values(ctx.config.networks)) {
    const repo = new Repo(ctx.layout.gitDir(netConfig.id), runner);
    // Three probes, not one.
    //
    // A single probe answers "did this one command work", and doctor reported
    // `✓ remote reachable` during a session where pushes were failing two times
    // in three — because intermittent auth (an SSH agent dropping a key, a
    // rate-limited host, a flapping VPN) walks straight past one attempt. An
    // intermittent transport is a different fault from a broken one, and it is
    // the one that makes people distrust the tool instead of the network.
    const attempts: string[] = [];
    let reached = 0;
    let rooms = 0;
    for (let probe = 0; probe < 3; probe += 1) {
      try {
        rooms = (await repo.lsRemoteRooms(netConfig.remote)).size;
        reached += 1;
      } catch (error) {
        attempts.push(conciseGitFailure(error));
      }
    }
    const where = `${netConfig.id} → ${netConfig.remote}`;
    if (reached === 3) {
      ok(`${where}: reachable (3/3), ${String(rooms)} room branch(es)`);
    } else if (reached > 0) {
      warn(
        `${where}: INTERMITTENT — reachable ${String(reached)}/3`,
        `failing probes said: ${[...new Set(attempts)].join(" · ")}\n` +
          "  messages still queue locally and go out on a later sync (oguri status shows the queue)",
      );
    } else {
      bad(
        `${where}: unreachable (0/3) — ${[...new Set(attempts)].join(" · ")}`,
        /permission|publickey|authentication/i.test(attempts.join(" "))
          ? `git asked for credentials it did not get. Check the identity this remote uses:\n` +
              `       ssh -T ${sshHostOf(netConfig.remote) ?? "git@<host>"}   ·   ssh-add -l`
          : "check the URL and your network",
      );
    }
    for (const roomId of netConfig.subscriptions) {
      const worktree = ctx.layout.roomWorktree(netConfig.id, roomId);
      try {
        await repo.runner.run(["rev-parse", "--is-inside-work-tree"], { cwd: worktree });
        ok(`${netConfig.id}/${roomId}: worktree healthy`);
      } catch {
        bad(`${netConfig.id}/${roomId}: worktree missing or broken`, `oguri room join ${roomId}`);
      }
    }
  }

  // A network of blank cards is a directory with no entries.
  //
  // oguri's premise is "ask the agent that owns that repo" — and the very
  // first question a new user asks is who owns what. Nothing at init fills the
  // card in, so the default state of a fresh network is one where the feature
  // that justifies the tool silently does not work: every card reads
  // `expertise: []`, and the answer has to be routed to a human anyway.
  await describeOwnCard(ctx, ok, warn);

  // The superagent's failures are silent ones — an argv nobody ran, a session
  // file read as "no context yet" — so they belong here rather than in the
  // first unattended run that hits them.
  await checkSuperagentDoctor(ctx.layout, ok, warn, bad);

  if (await DaemonClient.isAlive(ctx.layout.socketPath)) {
    ok("daemon running — messages arrive continuously");
  } else {
    // Whether this is a warning or a fault depends on something doctor did not
    // used to check: that `oguri daemon start` can actually launch anything.
    // Printing "start it with …" next to "no problems found", when that command
    // is guaranteed to fail, reads as a working instruction and sends people
    // looking for the fault in their own configuration.
    const entryProblem = await daemonEntryProblem();
    if (entryProblem === null) {
      // Not an error: direct mode works. But it changes the delivery model, so
      // say what is actually lost rather than just flagging it.
      warn(
        "daemon not running",
        "nothing accumulates while your agent is closed and no notifications fire; start it with 'oguri daemon start'",
      );
    } else {
      bad(
        `daemon cannot be launched — ${entryProblem}`,
        "reinstall oguri (npm i -g oguri), " +
          "or run 'oguri daemon run' in a terminal to host it in the foreground",
      );
    }
  }

  out();
  out(problems === 0 ? green("no problems found") : red(`${String(problems)} problem(s) found`));
  return problems === 0 ? 0 : 1;
}
