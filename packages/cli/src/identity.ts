import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AmbiguousIdentityError,
  IdentityMismatchError,
  Layout,
  type MachineIdentity,
  Network,
  type OguriConfig,
  defaultIdentity,
  describeError,
  emptyConfig,
  loadConfig,
  normalizeAgentTool,
} from "@oguri/core";
import { assertAgentId, assertMachineId, ulid } from "@oguri/protocol";

import { type Ctx, str } from "./context.ts";

export async function loadOrEmpty(layout: Layout): Promise<OguriConfig> {
  return (await loadConfig(layout.configPath)) ?? emptyConfig(defaultIdentity());
}

export function setIdentityTool(config: OguriConfig, value: string): boolean {
  const tool = normalizeAgentTool(value);
  if (config.agent.tool === tool) return false;
  const oldDefaultName = `${config.agent.human.name}'s ${config.agent.tool}`;
  config.agent = {
    ...config.agent,
    tool,
    displayName:
      config.agent.displayName === oldDefaultName
        ? `${config.agent.human.name}'s ${tool}`
        : config.agent.displayName,
  };
  return true;
}

export async function configuredAgentLayouts(layout: Layout): Promise<Layout[]> {
  const roots = new Set<string>([layout.root]);
  if (await pathExists(join(layout.agentRegistryRoot, "config.yaml"))) {
    roots.add(layout.agentRegistryRoot);
  }
  try {
    const entries = await readdir(layout.agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = join(layout.agentsDir, entry.name);
      if (await pathExists(join(root, "config.yaml"))) roots.add(root);
    }
  } catch {
    // A machine with only the current identity has no agents directory.
  }
  return [...roots].sort().map((root) => new Layout(root));
}

async function readRegisteredMachine(layout: Layout): Promise<MachineIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(layout.machineIdentityPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${layout.machineIdentityPath}: invalid JSON`);
  }
  const machine = (parsed as { machine?: Partial<MachineIdentity> } | null)?.machine;
  if (machine === undefined || typeof machine.id !== "string") {
    throw new Error(`${layout.machineIdentityPath}: missing machine.id`);
  }
  const id = assertMachineId(machine.id);
  const label =
    typeof machine.label === "string" && machine.label.trim() !== "" ? machine.label : id;
  return { id, label };
}

export async function writeRegisteredMachine(
  layout: Layout,
  machine: MachineIdentity,
): Promise<void> {
  await mkdir(layout.agentRegistryRoot, { recursive: true });
  const temporary = `${layout.machineIdentityPath}.${ulid()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ v: 1, machine }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await rename(temporary, layout.machineIdentityPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function registeredMachine(
  layout: Layout,
  fallback: MachineIdentity,
): Promise<MachineIdentity> {
  const existing = await readRegisteredMachine(layout);
  if (existing !== null) return existing;
  await mkdir(layout.agentRegistryRoot, { recursive: true });
  try {
    await writeFile(
      layout.machineIdentityPath,
      `${JSON.stringify({ v: 1, machine: fallback }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readRegisteredMachine(layout)) ?? fallback;
  }
}

export async function publishIdentityMetadata(
  layout: Layout,
  config: OguriConfig,
): Promise<string[]> {
  const failures: string[] = [];
  for (const networkConfig of Object.values(config.networks)) {
    const network = Network.open(layout, networkConfig, config.agent);
    try {
      // No presence transition: preserve the attached-session set while
      // refreshing identity fields on both shared documents.
      await network.publishAgentCard();
      await network.publishAgentProfile();
    } catch (error) {
      failures.push(`${config.agent.id}/${networkConfig.id}: ${describeError(error)}`);
    } finally {
      network.close();
    }
  }
  return failures;
}

/**
 * Commands that write a permanently attributed message.
 *
 * The gate applies to these and not to reads. Reading as the wrong agent shows
 * a confusing inbox and can be corrected by looking again; writing as the wrong
 * agent puts someone else's name on a message the whole team can read, forever.
 */
const ATTRIBUTING_COMMANDS = new Set([
  "send",
  "ask",
  "answer",
  "decide",
  "task",
  "review",
  "claim",
  "handshake",
  "worker",
  "plan",
]);

/** Commands that create or point at identities, so they must not be re-homed. */
export const IDENTITY_NEUTRAL_COMMANDS = new Set([
  "init",
  "agent",
  "setup",
  "uninstall",
  "mcp",
  "daemon",
  "doctor",
  // `runner presets` prints policy text: it reads no identity and writes nothing.
  "runner",
]);

/** Agent ids provisioned on this machine, each with its own OGURI_HOME. */
async function provisionedAgents(layout: Layout): Promise<string[]> {
  try {
    const entries = await readdir(layout.agentsDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await pathExists(join(layout.agentsDir, entry.name, "config.yaml"))) ids.push(entry.name);
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/**
 * Decide which identity this invocation acts as, and refuse if it is a guess.
 *
 * Two failures, both seen in practice. An agent shells out to `oguri` from a
 * terminal whose environment does not carry its `OGURI_HOME`, and the message
 * lands under whichever identity the default home happens to hold. Or a tool
 * believes it is pinned to one identity and is not. Both produce a permanent,
 * misattributed message, and the only repair is a second message admitting it.
 *
 * `--agent <id>` (or `OGURI_AGENT`) both SELECTS that agent's home and ASSERTS
 * the result, so it cannot silently resolve to somebody else.
 */
export async function resolveIdentity(
  ctx: Ctx,
  command: string,
): Promise<{ layout: Layout; config: OguriConfig }> {
  const asserted = str(ctx, "agent") ?? process.env["OGURI_AGENT"];
  const homeIsExplicit = process.env["OGURI_HOME"] !== undefined;

  if (asserted !== undefined && asserted !== "") {
    assertAgentId(asserted);
    // A pinned tool already selected its home. Treat --agent as an assertion
    // there, never as permission to jump sideways into a sibling tool's home.
    if (homeIsExplicit && ctx.layout.root !== ctx.layout.agentRegistryRoot) {
      if (ctx.config.agent.id !== asserted) {
        throw new IdentityMismatchError(asserted, ctx.config.agent.id, ctx.layout.root);
      }
      return { layout: ctx.layout, config: ctx.config };
    }
    // Prefer that agent's own home when one is provisioned, so the assertion is
    // a way to act AS them rather than only a way to fail.
    const home = ctx.layout.agentHomeDir(asserted);
    if (await pathExists(join(home, "config.yaml"))) {
      const layout = new Layout(home);
      const config = await loadOrEmpty(layout);
      if (config.agent.id !== asserted) {
        throw new IdentityMismatchError(asserted, config.agent.id, home);
      }
      return { layout, config };
    }
    if (ctx.config.agent.id !== asserted) {
      throw new IdentityMismatchError(asserted, ctx.config.agent.id, ctx.layout.root);
    }
    return { layout: ctx.layout, config: ctx.config };
  }

  if (!homeIsExplicit && ATTRIBUTING_COMMANDS.has(command)) {
    const candidates = await provisionedAgents(ctx.layout);
    if (candidates.length > 0) {
      throw new AmbiguousIdentityError(command, ctx.config.agent.id, candidates);
    }
  }
  return { layout: ctx.layout, config: ctx.config };
}

export async function pathExists(path: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
