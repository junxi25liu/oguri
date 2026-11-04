import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpCommandFor } from "../src/commands/worker-mcp-config.ts";
import { daemonEntryFor } from "../src/daemon-cmd.ts";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { selfScript } from "../src/self-script.ts";
import { cliEntryFor } from "../src/worker-service.ts";

/**
 * The npm package `oguri` is one bundled file run by node. Each way the CLI
 * starts itself again must run that file, never look for a separate `ogurid`
 * or rely on `oguri` being on a worker's PATH.
 */
const NODE = "/usr/local/bin/node";
const BUNDLE = "/usr/local/lib/node_modules/oguri/dist/oguri.cjs";

describe("the npm bundle starts itself", () => {
  it("hosts the daemon", () => {
    assert.deepEqual(daemonEntryFor(NODE, BUNDLE, null), {
      command: NODE,
      args: [BUNDLE, "daemon", "run"],
    });
  });

  it("serves a worker's MCP tools", () => {
    assert.deepEqual(mcpCommandFor(NODE, BUNDLE), { command: NODE, args: [BUNDLE, "mcp"] });
  });

  it("runs as a login service", () => {
    assert.deepEqual(cliEntryFor(NODE, BUNDLE), { command: NODE, args: [BUNDLE] });
  });
});

describe("a global npm install", () => {
  it("is recognised through the symlink npm puts on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "oguri-npm-"));
    try {
      const real = join(root, "lib", "node_modules", "oguri", "dist", "oguri.cjs");
      await mkdir(join(root, "lib", "node_modules", "oguri", "dist"), { recursive: true });
      await mkdir(join(root, "bin"));
      await writeFile(real, "");
      const onPath = join(root, "bin", "oguri");
      await symlink(real, onPath);
      const resolved = selfScript(onPath);
      assert.match(resolved ?? "", /oguri\.cjs$/);
      assert.deepEqual(daemonEntryFor(NODE, resolved, null).args.slice(1), ["daemon", "run"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
