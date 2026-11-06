import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { RunnerGrantStore } from "@oguri/core";

import { parseExpiry } from "../src/commands/runner-grants.ts";
import { testEnv } from "./env.ts";

/**
 * `oguri runner grant | revoke | list | request` through the built binary.
 *
 * The test process has no terminal, which is exactly the case that matters:
 * an agent driving the CLI through a pipe, or a worker's run, must not be
 * able to grant itself a runner. What a person does at a real terminal is
 * covered at the store level in core's runner-grants tests.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

let tmp: string;
let home: string;

async function oguri(
  extra: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  // This suite may itself run inside a worker's run; a test sets the task
  // variables only on purpose.
  const env = testEnv({ OGURI_HOME: home, NO_COLOR: "1" });
  delete env["OGURI_TASK_ID"];
  delete env["OGURI_TASK_ROOM"];
  Object.assign(env, extra);
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  await access(CLI);
  tmp = await mkdtemp(join(tmpdir(), "oguri-runner-grants-"));
  const remote = join(tmp, "transport.git");
  home = join(tmp, "home");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  const init = await oguri(
    {},
    "init",
    "--repo",
    remote,
    "--network",
    "acme",
    "--agent",
    "alice-big",
  );
  assert.equal(init.code, 0, init.stderr);
  // A machine-local policy in a temp home, never the person's real one.
  await writeFile(
    join(home, "policy.yaml"),
    [
      "v: 1",
      "worker:",
      "  enabled: true",
      "  runners:",
      '    cheap: { argv: ["claude", "-p", "--model", "my-cheap-model"] }',
      "",
    ].join("\n"),
  );
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri runner grants", () => {
  it("lists every runner as allowed while grants are off", async () => {
    const listed = await oguri({}, "runner", "list", "--json");
    assert.equal(listed.code, 0, listed.stderr);
    const view = JSON.parse(listed.stdout) as { enforced: boolean; runners: { runner: string }[] };
    assert.equal(view.enforced, false);
    assert.deepEqual(
      view.runners.map((row) => row.runner),
      ["cheap"],
    );
  });

  it("refuses a grant with no terminal, and audits the attempt", async () => {
    const granted = await oguri({}, "runner", "grant", "cheap");
    assert.equal(granted.code, 1);
    assert.match(granted.stderr, /interactive terminal/);
    const store = RunnerGrantStore.forHome(home);
    assert.equal((await store.state()).enforced, false, "no grants file was written");
    const last = (await store.auditLog()).at(-1);
    assert.equal(last?.action, "refused");
  });

  it("refuses Big's or a worker's run granting itself a runner", async () => {
    const granted = await oguri(
      { OGURI_TASK_ID: "01K0000000000000000000000A", OGURI_AGENT: "alice-big" },
      "runner",
      "grant",
      "cheap",
    );
    assert.equal(granted.code, 1);
    assert.match(granted.stderr, /a run cannot grant or revoke runners/);
    const revoked = await oguri(
      { OGURI_TASK_ID: "01K0000000000000000000000A" },
      "runner",
      "revoke",
      "cheap",
    );
    assert.equal(revoked.code, 1);
    assert.equal((await RunnerGrantStore.forHome(home).state()).enforced, false);
  });

  it("records a request, which grants nothing", async () => {
    const asked = await oguri(
      {},
      "runner",
      "request",
      "codexm",
      "the dashboard task names runner: codexm",
      "--json",
    );
    assert.equal(asked.code, 0, asked.stderr);
    const result = JSON.parse(asked.stdout) as { granted: boolean; request: { by: string } };
    assert.equal(result.granted, false);
    assert.equal(result.request.by, "alice-big");
    const store = RunnerGrantStore.forHome(home);
    assert.equal((await store.state()).enforced, false);
    assert.equal((await store.requests()).length, 1);
    const audit = await readFile(store.auditPath, "utf8");
    assert.match(audit, /"action":"request"/);
  });

  it("reads expiry as a duration or a time, and refuses the past", () => {
    const now = Date.parse("2026-11-05T00:00:00.000Z");
    assert.equal(parseExpiry("12h", now), "2026-11-05T12:00:00.000Z");
    assert.equal(parseExpiry("7d", now), "2026-11-12T00:00:00.000Z");
    assert.equal(parseExpiry("2026-11-06T00:00:00Z", now), "2026-11-06T00:00:00.000Z");
  });
});
