import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

import { mcpCommandFor } from "../src/commands/worker-mcp-config.ts";

/** `oguri worker mcp-config` prints what a runner needs and changes nothing it should not. */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

let tmp: string;
let home: string;

async function oguri(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: testEnv({ OGURI_HOME: home, NO_COLOR: "1" }),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-mcpcfg-"));
  home = join(tmp, "home");
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  assert.equal(
    (await oguri("init", "--repo", remote, "--network", "acme", "--agent", "cfg-agent", "--direct"))
      .code,
    0,
  );
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri worker mcp-config", () => {
  it("writes a private Claude MCP config that points at the oguri MCP server", async () => {
    const result = await oguri("worker", "mcp-config", "--runner", "claude", "--json");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const printed = JSON.parse(result.stdout) as { file: string; argv: string[] };
    assert.deepEqual(printed.argv.slice(0, 3), ["claude", "-p", "--mcp-config"]);
    assert.equal(printed.argv[3], printed.file);

    const config = JSON.parse(await readFile(printed.file, "utf8")) as {
      mcpServers: { oguri: { command: string; args: string[]; env: Record<string, string> } };
    };
    assert.equal(config.mcpServers.oguri.env["OGURI_HOME"], home);
    assert.match(config.mcpServers.oguri.args[0] ?? "", /mcp[\\/]dist[\\/]bin\.js$/);
    assert.equal(((await stat(printed.file)).mode & 0o777).toString(8), "600");
  });

  it("prints Codex -c overrides and writes nothing", async () => {
    const result = await oguri("worker", "mcp-config", "--runner", "codex", "--json");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const printed = JSON.parse(result.stdout) as { argv: string[] };
    assert.deepEqual(printed.argv.slice(0, 2), ["codex", "exec"]);
    assert.ok(printed.argv.some((a) => a.startsWith("mcp_servers.oguri.command=")));
    assert.equal(printed.argv.at(-1), "-", "the task is read from stdin");
  });

  it("never edits policy.yaml", async () => {
    await assert.rejects(() => stat(join(home, "policy.yaml")), { code: "ENOENT" });
  });

  it("refuses an unknown runner", async () => {
    const result = await oguri("worker", "mcp-config", "--runner", "bash");
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /must be 'claude' or 'codex'/);
  });
});

describe("the MCP command it prints", () => {
  it("runs the mcp package's entry from a workspace checkout", () => {
    assert.deepEqual(mcpCommandFor("/usr/bin/node", "/repo/packages/cli/dist/bin.js"), {
      command: "/usr/bin/node",
      args: ["/repo/packages/mcp/dist/bin.js"],
    });
  });

  it("runs a single-file binary as `oguri mcp`, which has no import.meta.url to resolve from", () => {
    assert.deepEqual(mcpCommandFor("/Users/b/.local/bin/oguri", "/Users/b/.local/bin/oguri"), {
      command: "/Users/b/.local/bin/oguri",
      args: ["mcp"],
    });
    assert.deepEqual(mcpCommandFor("/Users/b/.local/bin/oguri", undefined), {
      command: "/Users/b/.local/bin/oguri",
      args: ["mcp"],
    });
  });

  it("falls back to `oguri` on PATH when it is neither", () => {
    assert.deepEqual(mcpCommandFor("/usr/bin/node", undefined), {
      command: "oguri",
      args: ["mcp"],
    });
  });
});
