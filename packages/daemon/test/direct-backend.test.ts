import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Layout, loadConfig } from "@oguri/core";

import { openBackend } from "../src/backend.ts";

/**
 * Direct mode, asked about a network other than the one it is bound to.
 *
 * The daemon persists every open network after a subscription change. Direct
 * mode used to save only the bound one, so a join or leave addressed to a
 * second network worked for the lifetime of the process and then vanished.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

let tmp: string;
let home: string;

async function oguri(...args: string[]): Promise<void> {
  await exec(process.execPath, [CLI, ...args, "--direct"], {
    env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1" },
  });
}

async function savedSubscriptions(network: string): Promise<string[]> {
  const config = await loadConfig(new Layout(home).configPath);
  return [...(config?.networks[network]?.subscriptions ?? [])].sort();
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-direct-backend-"));
  home = join(tmp, "home");
  const first = join(tmp, "first.git");
  const second = join(tmp, "second.git");
  for (const repo of [first, second]) {
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", repo]);
  }
  await oguri("init", "--repo", first, "--network", "bound", "--agent", "ana-claude");
  await oguri("init", "--repo", second, "--network", "side");
  await oguri("room", "create", "aside", "--network", "side");
  await oguri("room", "create", "later", "--network", "side");
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("direct backend on a non-bound network", () => {
  it("saves a leave and a join to config.yaml", async () => {
    assert.deepEqual(await savedSubscriptions("side"), ["aside", "later"]);

    const backend = await openBackend({ layout: new Layout(home), forceDirect: true });
    try {
      await backend.call("roomLeave", { room: "later" }, "side");
      assert.deepEqual(await savedSubscriptions("side"), ["aside"], "the leave reaches disk");

      await backend.call("roomJoin", { room: "later" }, "side");
      assert.deepEqual(await savedSubscriptions("side"), ["aside", "later"], "so does the join");
    } finally {
      await backend.close();
    }
    assert.deepEqual(await savedSubscriptions("bound"), [], "the bound network is untouched");
  });
});
