import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  RunnerGrantStore,
  checkGrant,
  decodeGrants,
  grantRefusal,
  runnerDigest,
  type GrantActor,
  type WorkerRunner,
} from "@oguri/core";

/**
 * Runner grants: a person's local consent that an allow-listed runner may run.
 * Most of these are refusals, because a gate is only as good as the cases in
 * which it says no.
 */

const CHEAP: WorkerRunner = {
  argv: ["claude", "-p", "--model", "my-cheap-model", "--allowedTools", "Bash(git:*)"],
  worktree: true,
};
const PERSON: GrantActor = {
  human: "alice",
  user: "alice",
  agent: "alice-claude",
  via: "terminal",
};

let tmp: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-grants-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

let n = 0;
function store(): RunnerGrantStore {
  n += 1;
  return new RunnerGrantStore(join(tmp, `home-${String(n)}`));
}

describe("runner digest", () => {
  it("changes when any part of the runner that shapes the run changes", () => {
    const base = runnerDigest(CHEAP);
    assert.equal(
      base,
      runnerDigest({ ...CHEAP, argv: [...CHEAP.argv] }),
      "stable for equal entries",
    );
    assert.notEqual(base, runnerDigest({ ...CHEAP, argv: [...CHEAP.argv, "--dangerously"] }));
    assert.notEqual(base, runnerDigest({ ...CHEAP, model: "other" }));
    assert.notEqual(base, runnerDigest({ ...CHEAP, effort: "max" }));
    assert.notEqual(base, runnerDigest({ ...CHEAP, workdir: "/elsewhere" }));
    assert.notEqual(base, runnerDigest({ ...CHEAP, worktree: false }));
    assert.notEqual(base, runnerDigest({ ...CHEAP, resume: ["claude", "--resume", "{session}"] }));
  });
});

describe("runner grants", () => {
  it("leaves every runner allowed while no grants file exists", async () => {
    const grants = store();
    const state = await grants.state();
    assert.equal(state.enforced, false);
    assert.deepEqual(checkGrant(state, "cheap", CHEAP, "anyone"), { allowed: true });
  });

  it("allows a granted runner and refuses an ungranted one once grants are on", async () => {
    const grants = store();
    await grants.grant({ runner: "cheap", digest: runnerDigest(CHEAP) }, PERSON);
    const state = await grants.state();
    assert.equal(checkGrant(state, "cheap", CHEAP, "alice-claude").allowed, true);
    const other = checkGrant(
      state,
      "codexm",
      { argv: ["claude"], worktree: false },
      "alice-claude",
    );
    assert.equal(other.allowed, false);
    assert.match(other.allowed ? "" : other.reason, /no runner grant covers 'codexm'/);
  });

  it("stops applying when the runner's argv changes after the grant", async () => {
    const grants = store();
    await grants.grant({ runner: "cheap", digest: runnerDigest(CHEAP) }, PERSON);
    const edited: WorkerRunner = { ...CHEAP, argv: [...CHEAP.argv, "--allowedTools", "Bash(*)"] };
    const verdict = checkGrant(await grants.state(), "cheap", edited, "alice-claude");
    assert.equal(verdict.allowed, false);
    assert.match(verdict.allowed ? "" : verdict.reason, /issued for another argv/);
  });

  it("refuses after a revoke, with no restart, and keeps enforcement on", async () => {
    const grants = store();
    await grants.grant({ runner: "cheap", digest: runnerDigest(CHEAP) }, PERSON);
    assert.equal(checkGrant(await grants.state(), "cheap", CHEAP, "x").allowed, true);
    assert.equal(await grants.revoke("cheap", PERSON), true);
    const state = await grants.state();
    assert.equal(state.enforced, true, "revoking the last grant does not switch grants off");
    assert.equal(checkGrant(state, "cheap", CHEAP, "x").allowed, false);
    assert.equal(await grants.revoke("cheap", PERSON), false, "revoke is idempotent");
  });

  it("refuses an expired grant and a requester the grant does not name", async () => {
    const grants = store();
    await grants.grant(
      {
        runner: "cheap",
        digest: runnerDigest(CHEAP),
        for: ["alice-big"],
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
      PERSON,
    );
    const state = await grants.state();
    const early = Date.parse("2025-12-31T00:00:00.000Z");
    assert.equal(checkGrant(state, "cheap", CHEAP, "alice-big", early).allowed, true);
    const stranger = checkGrant(state, "cheap", CHEAP, "mallory-codex", early);
    assert.match(stranger.allowed ? "" : stranger.reason, /covers alice-big, not mallory-codex/);
    const late = checkGrant(state, "cheap", CHEAP, "alice-big", Date.parse("2026-02-01T00:00:00Z"));
    assert.match(late.allowed ? "" : late.reason, /expired/);
  });

  it("writes the grants file 0600 and fails closed when it is corrupt", async () => {
    const grants = store();
    await grants.grant({ runner: "cheap", digest: runnerDigest(CHEAP) }, PERSON);
    assert.equal((await stat(grants.grantsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(grants.auditPath)).mode & 0o777, 0o600);
    await writeFile(grants.grantsPath, '{"v":1,"grants":[{"runner":"cheap"', "utf8");
    const state = await grants.state();
    assert.equal(state.corrupt, true);
    const verdict = checkGrant(state, "cheap", CHEAP, "x");
    assert.match(verdict.allowed ? "" : verdict.reason, /could not be read/);
  });

  it("ignores a hand-written grant that names no person", () => {
    const state = decodeGrants(
      JSON.stringify({ v: 1, grants: [{ runner: "cheap", digest: runnerDigest(CHEAP) }] }),
    );
    assert.equal(state.grants.length, 0);
    assert.equal(checkGrant(state, "cheap", CHEAP, "x").allowed, false);
  });

  it("records a request without granting anything or switching grants on", async () => {
    const grants = store();
    const first = await grants.request({
      runner: "cheap",
      by: "alice-big",
      via: "mcp",
      reason: "the dashboard task asks for runner: cheap",
      taskId: "01K0000000000000000000000A",
    });
    assert.equal(first.duplicate, false);
    const again = await grants.request({
      runner: "cheap",
      by: "alice-big",
      via: "worker",
      reason: "asked again",
      taskId: "01K0000000000000000000000A",
    });
    assert.equal(again.duplicate, true, "one request per runner and task");
    const state = await grants.state();
    assert.equal(state.enforced, false, "a request never creates grants.json");
    assert.equal((await grants.requests()).length, 1);
    await assert.rejects(grants.request({ runner: "cheap", by: "x", via: "cli", reason: " " }));
  });

  it("keeps an audit trail that traces each grant and revoke to a person", async () => {
    const grants = store();
    await grants.request({ runner: "cheap", by: "alice-big", via: "mcp", reason: "needed" });
    await grants.grant({ runner: "cheap", digest: runnerDigest(CHEAP), note: "one day" }, PERSON);
    await grants.revoke("cheap", PERSON);
    const log = await grants.auditLog();
    assert.deepEqual(
      log.map((entry) => entry.action),
      ["request", "grant", "revoke"],
    );
    const granted = log[1];
    assert.ok(granted !== undefined && "human" in granted.actor);
    assert.equal(granted.actor.human, "alice");
    assert.equal(granted.actor.via, "terminal");
    assert.equal(granted.digest, runnerDigest(CHEAP));
    assert.deepEqual(log[0]?.actor, { agent: "alice-big", via: "mcp" });
    // Append-only: three lines, one per action.
    assert.equal((await readFile(grants.auditPath, "utf8")).trim().split("\n").length, 3);
  });

  it("shares one store across the agent homes of a machine", () => {
    const root = join(tmp, "machine");
    assert.equal(RunnerGrantStore.forHome(root).grantsPath, join(root, "grants.json"));
    assert.equal(
      RunnerGrantStore.forHome(join(root, "agents", "alice-big")).grantsPath,
      join(root, "grants.json"),
    );
  });
});

describe("who may grant", () => {
  it("refuses a worker's run, which is what Big and Small deploy", () => {
    const refusal = grantRefusal({ OGURI_TASK_ID: "01K0000000000000000000000A" }, true);
    assert.match(refusal ?? "", /a run cannot grant or revoke runners/);
  });

  it("refuses a process with no terminal", () => {
    assert.match(grantRefusal({}, false) ?? "", /interactive terminal/);
  });

  it("lets a person at a terminal grant", () => {
    assert.equal(grantRefusal({}, true), null);
  });
});
