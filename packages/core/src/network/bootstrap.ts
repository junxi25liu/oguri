/**
 * Joining a network for the first time on this machine.
 *
 * Kept apart from everything else because it runs before there is a `Network`
 * to delegate from: it clones or adopts the transport, brings `main` into
 * existence on an empty remote, and only then hands over to the constructor.
 */

import { MAIN_REF } from "@oguri/protocol";

import type { AgentIdentity, NetworkConfig } from "../config.ts";
import { exists } from "../fs.ts";
import { GitRunner } from "../git/runner.ts";
import { Repo } from "../git/repo.ts";
import type { Layout } from "../layout.ts";
import { StateDb } from "../state.ts";
import type { Network } from "../network.ts";

const REMOTE = "origin";

/**
 * Make a local, non-bare transport repository accept pushes.
 *
 * A transport that is a plain path on disk — the "no server at all" setup the
 * quickstart recommends — refuses a push to whichever branch it happens to have
 * checked out. In practice an editor holds `room/<id>` open and every send to
 * that room is rejected, which reads as a oguri fault rather than a git
 * default. `updateInstead` accepts the push and fast-forwards the worktree when
 * it is clean, and still refuses when it is dirty, so nobody's edits are lost.
 *
 * Best effort by design: a remote URL, an unwritable path, or a bare repo (which
 * has no checked-out branch and does not need this) all leave it alone.
 */
async function hardenLocalTransport(remote: string, runner: GitRunner): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || remote.includes("@")) return;
  try {
    const bare = await runner.text(["rev-parse", "--is-bare-repository"], { cwd: remote });
    if (bare.trim() === "true") return;
    await runner.run(["config", "receive.denyCurrentBranch", "updateInstead"], { cwd: remote });
  } catch {
    // Not a git repo, not reachable, or not ours to configure.
  }
}

/**
 * What bootstrapping needs that only the class can supply.
 *
 * The constructor is private, so the class hands over a way to call it rather
 * than making it public for the sake of this module.
 */
export interface BootstrapContext {
  construct(init: {
    layout: Layout;
    config: NetworkConfig;
    identity: AgentIdentity;
    repo: Repo;
    state: StateDb;
  }): Network;
}

/**
 * Clone (or adopt) a transport repository and register this agent on it.
 *
 * Handles the empty-remote case explicitly, because that is the normal state
 * of a private repo someone just created for their team.
 */
export async function init(
  ctx: BootstrapContext,
  options: {
    layout: Layout;
    networkId: string;
    remote: string;
    identity: AgentIdentity;
    runner?: GitRunner;
  },
): Promise<{ network: Network; createdNetwork: boolean }> {
  const { layout, networkId, remote, identity } = options;
  const runner = options.runner ?? new GitRunner();
  const gitDir = layout.gitDir(networkId);

  const repo = (await exists(gitDir))
    ? new Repo(gitDir, runner)
    : await Repo.cloneBare(remote, gitDir, runner);

  await repo.setFetchScope(REMOTE, []);
  await hardenLocalTransport(remote, runner);

  const recordWorktree = layout.recordWorktree(networkId);
  let createdNetwork = false;

  if (!(await exists(recordWorktree))) {
    if (await repo.refExists(MAIN_REF)) {
      await repo.addWorktree(recordWorktree, MAIN_REF);
    } else {
      // Empty remote: bring `main` into existence with the network manifest.
      createdNetwork = true;
      await repo.addOrphanWorktree(recordWorktree, MAIN_REF);
      await repo.commitFile(
        recordWorktree,
        ".oguri/net.yaml",
        `v: 1\nid: ${networkId}\nname: ${networkId}\nprotocol_version: 1\nauthenticity: git\n`,
        "oguri: initialise network",
      );
      await repo.pushNewBranch(recordWorktree, MAIN_REF, REMOTE);
    }
  }

  const config: NetworkConfig = { id: networkId, remote, subscriptions: [] };
  const network = ctx.construct({
    layout,
    config,
    identity,
    repo,
    state: StateDb.open(layout.statePath(networkId)),
  });

  await network.publishAgentCard();
  // The profile is advisory. Its commit is already durable locally if only
  // the push failed, and record-outbox sync will retry; onboarding must not
  // fail after the identity card has already registered successfully.
  await network.publishAgentProfile().catch(() => undefined);
  return { network, createdNetwork };
}
