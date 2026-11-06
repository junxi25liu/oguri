import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { DEFAULT_LOCAL_POLICY, type LocalPolicy } from "@oguri/core";

import { superagentFindings } from "../src/commands/doctor-superagent.ts";

/**
 * The superagent checks doctor adds.
 *
 * Every input is a policy object, a home directory, and a PATH — no network,
 * no daemon, no remote. That is deliberate: these checks exist for failures
 * that are silent (an argv nobody ran, a session file parsed as empty), and a
 * test that needed the whole transport to reach them would not be run.
 */

const exec = promisify(execFile);

let tmp: string;
let home: string;

function policyWith(edit: (policy: LocalPolicy) => void): LocalPolicy {
  const policy = structuredClone(DEFAULT_LOCAL_POLICY);
  edit(policy);
  return policy;
}

const levels = (findings: { level: string }[]): string[] => findings.map((f) => f.level);
const messages = (findings: { message: string }[]): string =>
  findings.map((f) => f.message).join("\n");

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-doctor-superagent-"));
  home = join(tmp, "home");
  await mkdir(home, { recursive: true });
});

after(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("doctor superagent checks", () => {
  it("says nothing when no superagent role is on", async () => {
    // A configured runner list with both roles off costs nothing, and doctor
    // should not manufacture a complaint out of an unused section.
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.worker.runners["missing"] = { argv: ["definitely-not-a-command-xyz"], worktree: false };
      }),
      home,
      pathEnv: "/usr/bin:/bin",
    });
    assert.deepEqual(findings, []);
  });

  it("reports a runner whose command is not on PATH", async () => {
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.superagent.big.enabled = true;
        p.worker.runners["ghost"] = { argv: ["definitely-not-a-command-xyz"], worktree: false };
        p.superagent.big.runner = "ghost";
      }),
      home,
      pathEnv: "/usr/bin:/bin",
    });
    assert.deepEqual(levels(findings), ["bad"]);
    assert.match(messages(findings), /not on PATH/);
    assert.match(messages(findings), /definitely-not-a-command-xyz/);
  });

  it("accepts a command found on PATH and prints where it resolved", async () => {
    // `node` is guaranteed: this test is running on it.
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.superagent.small.enabled = true;
        p.worker.runners["node"] = { argv: ["node", "-e", ""], worktree: false };
      }),
      home,
      pathEnv: `${join(tmp)}:${process.env["PATH"] ?? ""}`,
    });
    assert.deepEqual(levels(findings), ["ok"]);
    assert.match(messages(findings), /'node' is on PATH/);
  });

  it("reports a runner named where no runner is defined", async () => {
    // The parser lets a `superagent.*.runner` name anything; only this check
    // and `resolveThinker` notice it is not on the allow-list.
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.superagent.big.enabled = true;
        p.superagent.big.runner = "typo";
      }),
      home,
      pathEnv: process.env["PATH"] ?? "",
    });
    assert.deepEqual(levels(findings), ["bad"]);
    assert.match(messages(findings), /not in worker\.runners/);
  });

  it("still catches a named runner on a role that is switched off", async () => {
    // The role is off today, and a dangling name costs nothing yet — but it
    // will the moment someone flips `enabled`, and that is the quietest
    // possible moment to find out. Only a role with no name is skipped.
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.worker.runners["present"] = { argv: ["node"], worktree: false };
        p.superagent.big.runner = "typo";
      }),
      home,
      pathEnv: process.env["PATH"] ?? "",
    });
    assert.deepEqual(levels(findings), ["bad"]);
    assert.match(messages(findings), /superagent\.big names runner 'typo'/);
  });

  it("reports an enabled role with no runner at all", async () => {
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.superagent.small.enabled = true;
      }),
      home,
      pathEnv: process.env["PATH"] ?? "",
    });
    assert.deepEqual(levels(findings), ["bad"]);
    assert.match(messages(findings), /no runner is configured/);
  });

  it("reports a worktree base that is not a git repository", async () => {
    const plain = join(tmp, "not-a-repo");
    await mkdir(plain, { recursive: true });
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.worker.runners["isolated"] = { argv: ["node"], worktree: true, workdir: plain };
      }),
      home,
      pathEnv: process.env["PATH"] ?? "",
    });
    assert.deepEqual(levels(findings), ["bad"]);
    assert.match(messages(findings), /not a git repository/);
  });

  it("accepts a worktree base that is a repository", async () => {
    const repo = join(tmp, "a-repo");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "--quiet", repo]);
    const findings = await superagentFindings({
      policy: policyWith((p) => {
        p.worker.runners["isolated"] = { argv: ["node"], worktree: true, workdir: repo };
      }),
      home,
      pathEnv: process.env["PATH"] ?? "",
    });
    assert.deepEqual(levels(findings), ["ok"]);
    assert.match(messages(findings), /is a git repository/);
  });

  it("flags a damaged session file but not a healthy one", async () => {
    const dir = join(home, "superagent");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "big-session.json"), "{ this is not json");
    await writeFile(join(dir, "small-session.json"), JSON.stringify({ turns: 2 }));
    const findings = await superagentFindings({
      policy: structuredClone(DEFAULT_LOCAL_POLICY),
      home,
      pathEnv: process.env["PATH"] ?? "",
    });
    // Sorted by file name: big (damaged) first, then small (readable).
    assert.deepEqual(levels(findings), ["warn", "ok"]);
    // The damaged one is the warning; the readable one is the ok.
    const damaged = findings.find((f) => f.level === "warn");
    assert.match(damaged?.message ?? "", /big-session\.json is damaged/);
    assert.match(damaged?.hint ?? "", /rm /);
    const healthy = findings.find((f) => f.level === "ok");
    assert.match(healthy?.message ?? "", /small-session\.json is readable/);
  });

  it("does not walk a home with no superagent directory", async () => {
    const empty = join(tmp, "empty-home");
    await mkdir(empty, { recursive: true });
    const findings = await superagentFindings({
      policy: structuredClone(DEFAULT_LOCAL_POLICY),
      home: empty,
      pathEnv: process.env["PATH"] ?? "",
    });
    assert.deepEqual(findings, []);
  });

  it("is wired into 'oguri doctor'", async () => {
    // The unit tests above would all pass with the check never called.
    const wired = join(tmp, "wired-home");
    await mkdir(wired, { recursive: true });
    await writeFile(
      join(wired, "policy.yaml"),
      [
        "superagent:",
        "  big:",
        "    enabled: true",
        "    runner: ghost",
        "worker:",
        "  runners:",
        "    ghost:",
        "      argv: [definitely-not-a-command-xyz]",
        "",
      ].join("\n"),
    );
    const CLI = join(import.meta.dirname, "..", "dist", "bin.js");
    let stdout: string;
    try {
      ({ stdout } = await exec(process.execPath, [CLI, "doctor"], {
        env: { ...process.env, OGURI_HOME: wired, NO_COLOR: "1" },
      }));
    } catch (error) {
      // No network is configured here, so doctor exits 1; its report is still what we assert on.
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    assert.match(
      stdout,
      /superagent\.big runner 'ghost': the command 'definitely-not-a-command-xyz' is not on PATH/,
    );
  });
});
