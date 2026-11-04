import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type Ctx, bool, str, usage } from "../context.ts";
import { selfScript } from "../self-script.ts";
import { bold, dim, json, out } from "../output.ts";

/**
 * The command that starts oguri's MCP server, as a pure function of what this
 * process is.
 *
 * A workspace checkout runs the `mcp` package's own entry, found next to the
 * CLI's, and a packaged binary runs itself as `oguri mcp`. Neither is guessed
 * from `import.meta.url`: a single-file binary is bundled, so it has none, and
 * resolving it threw before anything was printed. The printed config keeps
 * working when `oguri-mcp` is not on the PATH of a launchd or systemd service.
 */
export function mcpCommandFor(
  execPath: string,
  argv1: string | undefined,
): { command: string; args: string[] } {
  if (argv1 !== undefined && /(?:^|[/\\])bin\.js$/.test(argv1)) {
    return { command: execPath, args: [join(dirname(argv1), "..", "..", "mcp", "dist", "bin.js")] };
  }
  // The npm package is one bundle: it serves MCP itself, with no PATH lookup,
  // since a worker's run often has a smaller PATH than the owner's shell.
  if (argv1 !== undefined && /(?:^|[/\\])oguri\.cjs$/.test(argv1)) {
    return { command: execPath, args: [argv1, "mcp"] };
  }
  const leaf = execPath.split(/[/\\]/).pop() ?? execPath;
  if (!/^node(\.exe)?$/i.test(leaf)) return { command: execPath, args: ["mcp"] };
  return { command: "oguri", args: ["mcp"] };
}

/** How a worker run starts oguri's MCP server from this process (ADR 0032). */
export function mcpCommand(): { command: string; args: string[] } {
  return mcpCommandFor(process.execPath, selfScript());
}

const SERVER_NAME = "oguri";

/** A Claude Code `--mcp-config` file body. The run's own env supplies the task. */
function claudeConfig(home: string): Record<string, unknown> {
  const { command, args } = mcpCommand();
  return {
    mcpServers: {
      [SERVER_NAME]: { command, args, env: { OGURI_HOME: home } },
    },
  };
}

/** `-c` overrides for `codex exec`, parsed as TOML by codex. */
function codexFlags(home: string): string[] {
  const { command, args } = mcpCommand();
  const quote = (value: string): string => JSON.stringify(value);
  return [
    "-c",
    `mcp_servers.${SERVER_NAME}.command=${quote(command)}`,
    "-c",
    `mcp_servers.${SERVER_NAME}.args=[${args.map(quote).join(", ")}]`,
    "-c",
    `mcp_servers.${SERVER_NAME}.env={ OGURI_HOME = ${quote(home)} }`,
  ];
}

/**
 * `oguri worker mcp-config [--runner claude|codex]` -- print what lets a
 * worker run use oguri's tools.
 *
 * It only prints, and for Claude writes a config file under the oguri home.
 * It never edits `policy.yaml` or a runner's argv: what a run may execute is
 * the machine owner's decision, and a tool that rewrites it would be a way
 * around that decision. The owner pastes the result into `worker.runners`.
 */
export async function cmdWorkerMcpConfig(ctx: Ctx): Promise<number> {
  const runner = str(ctx, "runner") ?? "claude";
  if (runner !== "claude" && runner !== "codex") {
    usage("--runner must be 'claude' or 'codex'");
  }
  const home = ctx.layout.root;
  const asJson = bool(ctx, "json");

  if (runner === "claude") {
    const path = join(home, "worker-mcp.json");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(claudeConfig(home), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    const argv = ["claude", "-p", "--mcp-config", path];
    if (asJson) {
      json({ runner, file: path, argv });
      return 0;
    }
    out(`${bold("claude")} wrote ${path}`);
    out(
      dim(
        "The worker already adds oguri's tools to a claude or codex runner by itself (ADR 0032); this is for a runner it does not recognise.",
      ),
    );
    out("");
    out("Add --mcp-config to the runner in ~/.oguri/policy.yaml:");
    out("");
    out("  worker:");
    out("    runners:");
    out(`      claude: ${JSON.stringify(argv)}`);
    out("");
    out(
      dim(
        "A run then has the oguri tools, including the progress and ask actions of oguri_task. It reads its task from OGURI_TASK_ID and OGURI_TASK_ROOM.",
      ),
    );
    return 0;
  }

  const argv = ["codex", "exec", ...codexFlags(home), "-"];
  if (asJson) {
    json({ runner, argv });
    return 0;
  }
  out(`${bold("codex")} MCP server as -c overrides:`);
  out("");
  out("  worker:");
  out("    runners:");
  out(`      codex: ${JSON.stringify(argv)}`);
  out("");
  out(dim("Nothing was changed. Paste the line into policy.yaml to use it."));
  return 0;
}
