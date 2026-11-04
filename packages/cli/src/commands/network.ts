import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ResolvedProjectBinding,
  describeError,
  normalizeProjectRole,
  resolveNetwork,
  resolveProjectBinding,
  saveConfig,
} from "@oguri/core";
import { openBackend } from "@oguri/daemon";
import { bold, dim, errline, green, json, out, red, yellow } from "../output.ts";

import { type Ctx, bool, str, usage } from "../context.ts";
import { withBackend } from "../with-backend.ts";

/**
 * List the networks on this machine, and choose which one commands mean.
 *
 * Multi-network has always existed in the config, and the daemon has always
 * polled every one of them — but changing which one a bare command meant took
 * editing `config.yaml` by hand, and reading another one meant `--network` on
 * every single invocation. So in practice people ran one network per machine
 * and reopened editors to switch, which is the opposite of what the transport
 * being a plain git remote makes possible.
 *
 * `use` writes `defaultNetwork` and nothing else. That matters for the case it
 * was avoided for: a running MCP server re-resolves the default on its next
 * call, so switching does **not** interrupt an agent session — no restart, no
 * reconnect, no lost context.
 */
export async function cmdNetwork(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "list";

  if (sub === "use") {
    const wanted = ctx.positionals[2];
    if (wanted === undefined) usage("network use needs a network id");
    if (ctx.config.networks[wanted] === undefined) {
      errline(red(`✗ unknown network ${wanted}`));
      errline(dim(`  have: ${Object.keys(ctx.config.networks).join(", ") || "none"}`));
      errline(dim(`  add one with: oguri init --repo <url> --network ${wanted}`));
      return 1;
    }
    if (ctx.config.defaultNetwork === wanted) {
      out(dim(`already on ${wanted}`));
      return 0;
    }
    ctx.config.defaultNetwork = wanted;
    await saveConfig(ctx.layout.configPath, ctx.config);
    out(green(`✓ default network is now ${bold(wanted)}`));
    out(dim("  unbound folders pick this up on their next call — no restart needed"));
    return 0;
  }

  if (sub !== "list") usage(`unknown network command '${sub}' (list | use <id>)`);

  return await withBackend(ctx, async (be) => {
    const networks = await be.networks();
    if (bool(ctx, "json")) {
      json(networks);
      return 0;
    }
    if (networks.length === 0) {
      out(dim("no networks configured"));
      out(dim("  oguri init --repo <url>"));
      return 0;
    }
    for (const net of networks) {
      const mark = net.current ? green("→") : " ";
      const rooms = net.subscriptions.length === 0 ? dim("no rooms") : net.subscriptions.join(", ");
      out(`${mark} ${bold(net.id.padEnd(18))} ${rooms}`);
      out(`  ${dim(net.remote)}`);
    }
    if (networks.length > 1) {
      out();
      out(dim("oguri network use <id> · or --network <id> on any single command"));
      out(dim("reads take --all-networks, so waiting does not mean picking one"));
    }
    return 0;
  });
}

async function canonicalProjectPath(input: string): Promise<string> {
  const path = await realpath(input);
  if (!(await stat(path)).isDirectory())
    throw new Error(`project path is not a directory: ${path}`);
  return path;
}

async function publishProjectRole(
  ctx: Ctx,
  binding: ResolvedProjectBinding,
): Promise<string | null> {
  const backend = await openBackend({
    layout: ctx.layout,
    network: binding.network,
    ...(bool(ctx, "direct") ? { forceDirect: true } : {}),
  });
  try {
    await backend.call("profileUpdate", { input: { role: binding.role } });
    return null;
  } catch (error) {
    return describeError(error);
  } finally {
    await backend.close();
  }
}

export async function cmdProject(ctx: Ctx): Promise<number> {
  const sub = ctx.positionals[1] ?? "current";

  if (sub === "bind") {
    if (ctx.positionals.length > 3) usage("project bind accepts at most one path");
    const network = str(ctx, "network");
    const rawRole = str(ctx, "role");
    if (network === undefined || rawRole === undefined) {
      usage("project bind needs --network <id> --role <text>");
    }
    if (ctx.config.networks[network] === undefined) {
      errline(red(`✗ unknown network ${network}`));
      errline(dim(`  have: ${Object.keys(ctx.config.networks).join(", ") || "none"}`));
      errline(dim(`  add it with: oguri init --repo <url> --network ${network}`));
      return 1;
    }
    const path = await canonicalProjectPath(ctx.positionals[2] ?? process.cwd());
    const role = normalizeProjectRole(rawRole);
    const conflict = Object.entries(ctx.config.projects).find(
      ([otherPath, binding]) =>
        otherPath !== path && binding.network === network && binding.role !== role,
    );
    if (conflict !== undefined) {
      errline(red(`✗ network ${network} already publishes another role for this agent`));
      errline(dim(`  ${conflict[0]} → ${conflict[1].role}`));
      errline(
        dim(
          "  one agent has one profile per network; reuse that role or bind a separate OGURI_HOME identity",
        ),
      );
      return 1;
    }

    ctx.config.projects[path] = { network, role };
    await saveConfig(ctx.layout.configPath, ctx.config);
    const binding = { path, network, role };
    const publishError = await publishProjectRole(ctx, binding);
    if (bool(ctx, "json")) {
      json({ ...binding, rolePublished: publishError === null, publishError });
      return 0;
    }
    out(green("✓ project bound") + dim(` ${path}`));
    out(`  network ${bold(network)}`);
    out(`  role    ${role}`);
    if (publishError !== null) {
      out(yellow("! binding saved, but the role could not be published yet"));
      out(dim(`  ${publishError}`));
      out(dim("  the next project MCP session retries it"));
    }
    return 0;
  }

  if (sub === "unbind") {
    if (ctx.positionals.length > 3) usage("project unbind accepts at most one path");
    const input = ctx.positionals[2];
    let path: string;
    if (input === undefined) {
      const current = resolveProjectBinding(ctx.config, process.cwd());
      if (current === null) {
        if (bool(ctx, "json")) json({ removed: false, path: null });
        else out(dim("this folder has no project binding"));
        return 0;
      }
      path = current.path;
    } else {
      path = await realpath(input).catch(() => resolve(input));
    }
    const removed = ctx.config.projects[path] !== undefined;
    delete ctx.config.projects[path];
    if (removed) await saveConfig(ctx.layout.configPath, ctx.config);
    if (bool(ctx, "json")) json({ removed, path });
    else out(removed ? green(`✓ project unbound ${path}`) : dim(`no binding for ${path}`));
    return 0;
  }

  if (sub === "list") {
    if (ctx.positionals.length > 2) usage("project list accepts no path");
    const current = resolveProjectBinding(ctx.config, process.cwd());
    const projects = Object.entries(ctx.config.projects)
      .map(([path, binding]) => ({ path, ...binding, current: current?.path === path }))
      .sort((a, b) =>
        a.current === b.current ? a.path.localeCompare(b.path) : a.current ? -1 : 1,
      );
    if (bool(ctx, "json")) {
      json(projects);
      return 0;
    }
    if (projects.length === 0) {
      out(dim("no project bindings — add one from a project folder:"));
      out(dim("  oguri project bind . --network <id> --role '<role>'"));
      return 0;
    }
    for (const project of projects) {
      out(`${project.current ? green("→") : " "} ${bold(project.path)}`);
      out(`  ${project.network} · ${project.role}`);
    }
    return 0;
  }

  if (sub !== "current") usage(`unknown project command '${sub}' (bind | current | list | unbind)`);
  if (ctx.positionals.length > 2) usage("project current accepts no path");
  const current = resolveProjectBinding(ctx.config, process.cwd());
  if (current !== null) {
    if (bool(ctx, "json")) json({ bound: true, ...current });
    else {
      out(`${green("→")} ${bold(current.network)} · ${current.role}`);
      out(dim(`  bound by ${current.path}`));
    }
    return 0;
  }
  const fallback = resolveNetwork(ctx.config, str(ctx, "network"));
  if (bool(ctx, "json")) json({ bound: false, network: fallback.id, role: null, path: null });
  else {
    out(dim(`no project binding; bare commands fall back to network ${fallback.id}`));
    out(dim("  oguri project bind . --network <id> --role '<role>'"));
  }
  return 0;
}
