import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";

import { defaultIdentity } from "../src/config.ts";
import { ApprovalRequiredError } from "../src/errors.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import {
  DEFAULT_LOCAL_POLICY,
  approvalRequired,
  originOf,
  parseLocalPolicy,
  policySearchPath,
  policyTemplate,
} from "../src/policy.ts";

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

describe("policy file", () => {
  it("defaults to asking about remote work and nothing else", () => {
    assert.equal(DEFAULT_LOCAL_POLICY.approvals.inboundWork, "remote");
    assert.deepEqual(DEFAULT_LOCAL_POLICY.approvals.localAgents, []);
  });

  it("parses the template it ships, so the documented example is the real grammar", () => {
    const parsed = parseLocalPolicy(policyTemplate(), "template");
    assert.equal(parsed.approvals?.inboundWork, "remote");
    assert.deepEqual(parsed.approvals?.localAgents, []);
  });

  it("refuses a misspelled key instead of silently ignoring it", () => {
    // The whole point of this file is constraining an agent. Ignoring an
    // unknown key would leave a person believing a limit is in force.
    assert.throws(
      () => parseLocalPolicy("v: 1\napprovals:\n  inboundwork: never\n", "p.yaml"),
      /unknown key 'approvals.inboundwork'/,
    );
    assert.throws(() => parseLocalPolicy("approval:\n  x: 1\n", "p.yaml"), /unknown top-level key/);
  });

  it("refuses an unknown mode, a bad agent id, and a future version", () => {
    assert.throws(
      () => parseLocalPolicy("approvals:\n  inboundWork: sometimes\n", "p.yaml"),
      /must be one of: never, remote, always/,
    );
    assert.throws(
      () => parseLocalPolicy("approvals:\n  localAgents: ['not a valid id']\n", "p.yaml"),
      /invalid agent id/,
    );
    assert.throws(() => parseLocalPolicy("v: 2\n", "p.yaml"), /unsupported policy version 2/);
  });

  it("refuses the removed activation section and points at the worker", () => {
    // ADR 0026 replaced the daemon's wake-up command. Ignoring an old section
    // would leave someone believing it still runs.
    assert.throws(
      () => parseLocalPolicy("activation:\n  mode: command\n", "p.yaml"),
      /'activation' was removed; use the 'worker' section/,
    );
  });

  it("treats an empty file as all defaults", () => {
    assert.deepEqual(parseLocalPolicy("", "p.yaml"), {});
    assert.deepEqual(parseLocalPolicy("# just a comment\n", "p.yaml"), {});
  });

  it("keeps the worker off, with tight limits, unless a person turns it on", () => {
    // ADR 0026: executing another machine's task is opt-in per machine.
    assert.equal(DEFAULT_LOCAL_POLICY.worker.enabled, false);
    assert.equal(DEFAULT_LOCAL_POLICY.worker.concurrency, 1);
    assert.deepEqual(DEFAULT_LOCAL_POLICY.worker.runners, {});
    assert.deepEqual(DEFAULT_LOCAL_POLICY.worker.trustedRequesters, []);
    assert.equal(parseLocalPolicy(policyTemplate(), "template").worker?.enabled, false);

    const parsed = parseLocalPolicy(
      [
        "worker:",
        "  enabled: true",
        "  concurrency: 2",
        "  timeoutMinutes: 30",
        "  workdir: ~/src",
        "  runners:",
        "    claude: [claude, -p]",
        "    codex: [codex, exec, '-']",
        "  defaultRunner: codex",
        "  trustedRequesters: [alice-claude, alice-claude]",
        "",
      ].join("\n"),
      "p.yaml",
    );
    assert.equal(parsed.worker?.enabled, true);
    assert.equal(parsed.worker?.concurrency, 2);
    assert.equal(parsed.worker?.maxPerHour, 6, "unset limits keep their default");
    assert.deepEqual(parsed.worker?.runners["codex"], {
      argv: ["codex", "exec", "-"],
      worktree: false,
    });
    assert.equal(parsed.worker?.onAbandon, "release", "a cut-off task goes back by default");
    assert.equal(parsed.worker?.defaultRunner, "codex");
    assert.equal(parsed.worker?.plannerRunner, undefined, "unset: oguri plan uses defaultRunner");
    assert.deepEqual(parsed.worker?.trustedRequesters, ["alice-claude"]);
  });

  it("refuses a worker that could not run safely or as written", () => {
    const bad = (body: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(`worker:\n${body}`, "p.yaml"), pattern);
    bad("  enabled: true\n", /runners is empty/);
    bad("  enabled: yes please\n", /enabled must be true or false/);
    bad("  runners:\n    claude: 'claude -p'\n", /non-empty list of strings/);
    bad("  runners:\n    Bad_Name: [x]\n", /invalid name 'Bad_Name'/);
    bad("  runners:\n    a: [x]\n  defaultRunner: b\n", /defaultRunner must name/);
    bad("  runners:\n    a: [x]\n  plannerRunner: b\n", /plannerRunner must name/);
    bad("  concurrency: 0\n", /concurrency must be an integer from 1 to 8/);
    bad("  timeoutMinutes: 5000\n", /timeoutMinutes/);
    bad("  trustedRequesters: ['not valid']\n", /invalid agent id/);
    bad("  agent: claude\n", /unknown key 'worker.agent'/);
  });

  it("reads a runner as argv or as a mapping with its own workdir and worktree", () => {
    const parsed = parseLocalPolicy(
      [
        "worker:",
        "  enabled: true",
        "  onAbandon: block",
        "  runners:",
        "    short: [claude, -p]",
        "    fixer:",
        "      argv: [codex, exec, '-']",
        "      workdir: ~/src/app",
        "      worktree: true",
        "    plain:",
        "      argv: [claude]",
        "",
      ].join("\n"),
      "p.yaml",
    );
    assert.deepEqual(parsed.worker?.runners, {
      short: { argv: ["claude", "-p"], worktree: false },
      fixer: { argv: ["codex", "exec", "-"], workdir: "~/src/app", worktree: true },
      plain: { argv: ["claude"], worktree: false },
    });
    assert.equal(parsed.worker?.onAbandon, "block");

    // worker.workdir is enough for a worktree runner to know its repository.
    const shared = parseLocalPolicy(
      "worker:\n  workdir: ~/src/app\n  runners:\n    a:\n      argv: [x]\n      worktree: true\n",
      "p.yaml",
    );
    assert.equal(shared.worker?.runners["a"]?.worktree, true);
  });

  it("reads a runner's model and refuses one that could become another flag", () => {
    const parsed = parseLocalPolicy(
      [
        "worker:",
        "  enabled: true",
        "  runners:",
        "    cheap:",
        "      argv: [claude, -p]",
        "      model: deepseek-v4.1-flash",
        "    codex:",
        "      argv: [codex, exec, '-']",
        "      model: gpt-5-codex",
        "    plain: [claude, -p]",
        "",
      ].join("\n"),
      "p.yaml",
    );
    assert.equal(parsed.worker?.runners["cheap"]?.model, "deepseek-v4.1-flash");
    assert.equal(parsed.worker?.runners["codex"]?.model, "gpt-5-codex");
    assert.equal(parsed.worker?.runners["plain"]?.model, undefined);

    const bad = (body: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(`worker:\n  runners:\n${body}`, "p.yaml"), pattern);
    bad("    a:\n      argv: [claude, -p]\n      model: 42\n", /worker.runners.a.model/);
    bad("    a:\n      argv: [claude, -p]\n      model: '--danger'\n", /worker.runners.a.model/);
    bad("    a:\n      argv: [claude, -p]\n      model: ''\n", /worker.runners.a.model/);
    bad("    a:\n      argv: [claude, -p]\n      model: 'two words'\n", /worker.runners.a.model/);
  });

  it("refuses a runner mapping it does not fully understand", () => {
    const bad = (body: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(`worker:\n  runners:\n${body}`, "p.yaml"), pattern);
    bad("    a:\n      cmd: [x]\n", /unknown key 'worker.runners.a.cmd'/);
    bad("    a:\n      workdir: /tmp\n", /worker.runners.a.argv must be a non-empty list/);
    bad("    a:\n      argv: 'claude -p'\n", /worker.runners.a.argv must be a non-empty list/);
    bad("    a:\n      argv: [x]\n      worktree: yes\n", /worktree must be true or false/);
    bad("    a:\n      argv: [x]\n      workdir: ''\n", /worker.runners.a.workdir must be a path/);
    bad("    a:\n      argv: [x]\n      worktree: true\n", /names no repository/);
    bad("    a: 7\n", /must be a non-empty list of strings .* or a mapping/);
    assert.throws(
      () => parseLocalPolicy("worker:\n  onAbandon: retry\n", "p.yaml"),
      /worker.onAbandon must be one of: release, block/,
    );
  });

  it("reads worker capabilities and the retry policy, with safe defaults", () => {
    const defaults = parseLocalPolicy("worker:\n  enabled: false\n", "p.yaml");
    assert.deepEqual(defaults.worker?.capabilities, []);
    assert.deepEqual(
      defaults.worker?.retry,
      { backoffMinutes: 10 },
      "no onFailure: the task's maxAttempts decides",
    );
    assert.deepEqual(parseLocalPolicy(policyTemplate(), "template").worker?.retry, {
      backoffMinutes: 10,
    });

    const parsed = parseLocalPolicy(
      [
        "worker:",
        "  capabilities: [gpu, macos, gpu]",
        "  retry:",
        "    onFailure: block",
        "    backoffMinutes: 0",
        "",
      ].join("\n"),
      "p.yaml",
    );
    assert.deepEqual(parsed.worker?.capabilities, ["gpu", "macos"]);
    assert.deepEqual(parsed.worker?.retry, { onFailure: "block", backoffMinutes: 0 });

    const bad = (body: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(`worker:\n${body}`, "p.yaml"), pattern);
    bad("  capabilities: gpu\n", /worker.capabilities must be a list/);
    bad("  capabilities: ['Has a GPU']\n", /invalid name "Has a GPU"/);
    bad(
      `  capabilities: [${Array.from({ length: 17 }, (_, i) => `c${String(i)}`).join(", ")}]\n`,
      /more than 16/,
    );
    assert.equal(
      parseLocalPolicy(
        "worker:\n  runners:\n    a: [x]\n    b: [y]\n  plannerRunner: b\n",
        "p.yaml",
      ).worker?.plannerRunner,
      "b",
    );
    bad("  retry: release\n", /worker.retry must be a mapping/);
    bad("  retry:\n    onFailure: retry\n", /onFailure must be one of: release, block/);
    bad("  retry:\n    backoffMinutes: -1\n", /retry.backoffMinutes must be an integer/);
    bad("  retry:\n    attempts: 3\n", /unknown key 'worker.retry.attempts'/);
  });

  it("never lets a caller mutate the default retry policy", () => {
    const one = parseLocalPolicy("worker:\n  enabled: false\n", "p.yaml").worker;
    if (one !== undefined) one.retry.backoffMinutes = 99;
    assert.equal(DEFAULT_LOCAL_POLICY.worker.retry.backoffMinutes, 10);
    assert.equal(
      parseLocalPolicy("worker:\n  enabled: false\n", "p.yaml").worker?.retry.backoffMinutes,
      10,
    );
  });

  it("reads a session runner with resume and session, and validates both", () => {
    const parsed = parseLocalPolicy(
      [
        "worker:",
        "  enabled: true",
        "  runners:",
        "    plain: [claude, -p]",
        "    chat:",
        "      argv: [claude, -p, --output-format, json]",
        '      resume: [claude, -p, --output-format, json, --resume, "{session}"]',
        "      session: claude-json",
        "    codex:",
        "      argv: [codex, exec, --json, '-']",
        "      resume: [codex, exec, --json, resume, '{session}', '-']",
        "      session: codex-jsonl",
        "    own:",
        "      argv: [agent]",
        "      session: file",
        "",
      ].join("\n"),
      "p.yaml",
    );
    assert.deepEqual(parsed.worker?.runners["plain"], { argv: ["claude", "-p"], worktree: false });
    assert.deepEqual(parsed.worker?.runners["chat"], {
      argv: ["claude", "-p", "--output-format", "json"],
      worktree: false,
      resume: ["claude", "-p", "--output-format", "json", "--resume", "{session}"],
      session: "claude-json",
    });
    assert.equal(parsed.worker?.runners["codex"]?.session, "codex-jsonl");
    // A session without resume is allowed: the id is recorded, follow-ups replay the conversation.
    assert.deepEqual(parsed.worker?.runners["own"], {
      argv: ["agent"],
      worktree: false,
      session: "file",
    });

    const bad = (body: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(`worker:\n  runners:\n${body}`, "p.yaml"), pattern);
    bad(
      "    a:\n      argv: [x]\n      resume: [x, '{session}']\n",
      /resume needs session: claude-json \| codex-jsonl \| file/,
    );
    bad(
      "    a:\n      argv: [x]\n      resume: [x, --resume]\n      session: file\n",
      /must contain \{session\} exactly once \(found 0\)/,
    );
    bad(
      "    a:\n      argv: [x]\n      resume: ['{session}', '{session}']\n      session: file\n",
      /exactly once \(found 2\)/,
    );
    bad(
      "    a:\n      argv: [x]\n      resume: ['--id={session}{session}']\n      session: file\n",
      /exactly once \(found 2\)/,
    );
    bad(
      "    a:\n      argv: [x]\n      resume: 'x {session}'\n      session: file\n",
      /resume must be a non-empty list of strings/,
    );
    bad("    a:\n      argv: [x]\n      session: json\n", /session must be one of: claude-json/);
    bad(
      "    a:\n      argv: [x]\n      sessions: file\n",
      /unknown key 'worker.runners.a.sessions'/,
    );
  });

  it("reads worker.followupDays, default 14, 0 to turn it off", () => {
    assert.equal(DEFAULT_LOCAL_POLICY.worker.followupDays, 14);
    assert.equal(
      parseLocalPolicy("worker:\n  enabled: false\n", "p.yaml").worker?.followupDays,
      14,
    );
    assert.equal(
      parseLocalPolicy("worker:\n  followupDays: 0\n", "p.yaml").worker?.followupDays,
      0,
    );
    assert.equal(parseLocalPolicy(policyTemplate(), "template").worker?.followupDays, 14);
    assert.throws(
      () => parseLocalPolicy("worker:\n  followupDays: -1\n", "p.yaml"),
      /worker.followupDays must be an integer from 0 to 365/,
    );
  });

  it("looks in the machine root as well, when running as a provisioned agent", () => {
    const machine = policySearchPath(new Layout("/home/u/.oguri"));
    assert.deepEqual(machine, ["/home/u/.oguri/policy.yaml"]);

    // A per-agent home is <root>/agents/<id>. Without the machine-root lookup a
    // policy set once would be silently ignored by every provisioned agent.
    const agent = policySearchPath(new Layout("/home/u/.oguri/agents/bob-codex"));
    assert.deepEqual(agent, [
      "/home/u/.oguri/policy.yaml",
      "/home/u/.oguri/agents/bob-codex/policy.yaml",
    ]);
  });
});

describe("work origin", () => {
  const policy = { inboundWork: "remote" as const, localAgents: ["sibling-codex"] };

  it("counts this agent and listed agents as local, everything else as remote", () => {
    assert.equal(originOf("me-claude", "me-claude", policy), "local");
    assert.equal(originOf("sibling-codex", "me-claude", policy), "local");
    assert.equal(originOf("stranger-cursor", "me-claude", policy), "remote");
  });

  it("applies each mode to each origin", () => {
    const modes = ["never", "remote", "always"] as const;
    const expected: Record<string, [boolean, boolean]> = {
      // [local, remote]
      never: [false, false],
      remote: [false, true],
      always: [true, true],
    };
    for (const mode of modes) {
      const p = { inboundWork: mode, localAgents: [] };
      const [local, remote] = expected[mode] as [boolean, boolean];
      assert.equal(approvalRequired("local", p), local, `${mode}/local`);
      assert.equal(approvalRequired("remote", p), remote, `${mode}/remote`);
    }
  });
});

describe("inbound work gate", () => {
  let tmp: string;
  let remote: string;
  let alice: Network;
  let bob: Network;
  let bobHome: string;

  async function setBobPolicy(body: string | null): Promise<void> {
    const path = join(bobHome, "policy.yaml");
    if (body === null) await rm(path, { force: true });
    else await writeFile(path, body, "utf8");
  }

  /** A fresh task from alice, synced into bob's view. Returns its id. */
  async function delegate(title: string): Promise<string> {
    const created = await alice.createTask("gate", { title, definition: `${title} definition.` });
    await bob.sync();
    return created.header.task?.id as string;
  }

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oguri-policy-"));
    remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    alice = (
      await Network.init({
        layout: new Layout(join(tmp, "alice")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "alice-codex" }),
      })
    ).network;
    await alice.createRoom("gate");
    bobHome = join(tmp, "bob");
    bob = (
      await Network.init({
        layout: new Layout(bobHome),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-claude" }),
      })
    ).network;
    await bob.joinRoom("gate");
  });

  beforeEach(async () => {
    await setBobPolicy(null);
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("refuses a remote teammate's task by default, and says exactly how to proceed", async () => {
    const taskId = await delegate("Wire the ledger migration");
    const error = await bob
      .claimTask("gate", taskId, "Taking it.")
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(error instanceof ApprovalRequiredError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, "APPROVAL_REQUIRED");
    assert.equal(error.requester, "alice-codex");
    assert.equal(error.kind, "task");
    assert.match(error.message, /oguri task approve gate/);

    // The refusal must not have half-happened: nobody owns the task.
    const status = (await bob.listTasks("gate")).find((t) => t.task.id === taskId);
    assert.equal(status?.task.state, "open");
    assert.equal(status?.task.assignee, undefined);
  });

  it("lets the claim through once a person has approved it, and only that one", async () => {
    const approved = await delegate("Approved work");
    const other = await delegate("Not approved work");

    await bob.approveInboundWork("task", "gate", approved, "andrey said go");
    const claimed = await bob.claimTask("gate", approved, "Taking it.");
    assert.equal(claimed.header.task?.assignee, "bob-claude");

    await assert.rejects(
      bob.claimTask("gate", other, "Taking this one too."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "approval is per piece of work, never a blanket unlock",
    );

    const records = await bob.listApprovals();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, approved);
    assert.equal(records[0]?.note, "andrey said go");
  });

  it("never gates work this agent created for itself", async () => {
    const own = await bob.createTask("gate", {
      title: "My own work",
      definition: "Nobody delegated this.",
    });
    const claimed = await bob.claimTask("gate", own.header.task?.id as string, "Mine.");
    assert.equal(claimed.header.task?.assignee, "bob-claude");
  });

  it("treats a listed agent as local", async () => {
    const taskId = await delegate("From a listed peer");
    await setBobPolicy("v: 1\napprovals:\n  localAgents: [alice-codex]\n");
    const claimed = await bob.claimTask("gate", taskId, "Taking it.");
    assert.equal(claimed.header.task?.assignee, "bob-claude");
  });

  it("takes anything when set to never, and everything when set to always", async () => {
    const remoteTask = await delegate("Remote under never");
    await setBobPolicy("v: 1\napprovals:\n  inboundWork: never\n");
    assert.equal(
      (await bob.claimTask("gate", remoteTask, "Taking it.")).header.task?.assignee,
      "bob-claude",
    );

    await setBobPolicy("v: 1\napprovals:\n  inboundWork: always\n");
    const own = await bob.createTask("gate", {
      title: "Own work under always",
      definition: "Even this is gated.",
    });
    await assert.rejects(
      bob.claimTask("gate", own.header.task?.id as string, "Mine."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "'always' must gate even work the agent created itself",
    );
  });

  it("re-reads the file, so tightening the rules takes effect immediately", async () => {
    await setBobPolicy("v: 1\napprovals:\n  inboundWork: never\n");
    const first = await delegate("Before tightening");
    await bob.claimTask("gate", first, "Taking it.");

    await setBobPolicy("v: 1\napprovals:\n  inboundWork: remote\n");
    const second = await delegate("After tightening");
    await assert.rejects(
      bob.claimTask("gate", second, "Taking it."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "a policy change must not wait for a restart",
    );
  });

  it("withdraws an approval that has not been used", async () => {
    const taskId = await delegate("Withdrawn");
    await bob.approveInboundWork("task", "gate", taskId);
    assert.equal(await bob.revokeApproval("task", taskId), true);
    assert.equal(await bob.revokeApproval("task", taskId), false);
    await assert.rejects(
      bob.claimTask("gate", taskId, "Taking it."),
      (error: unknown) => error instanceof ApprovalRequiredError,
    );
  });

  it("holds the gate when the approvals file is corrupt, rather than opening it", async () => {
    const taskId = await delegate("Corrupt store");
    await bob.approveInboundWork("task", "gate", taskId);
    await writeFile(join(bobHome, "networks", "acme", "approvals.json"), "{ truncated", "utf8");
    await assert.rejects(
      bob.claimTask("gate", taskId, "Taking it."),
      (error: unknown) => error instanceof ApprovalRequiredError,
      "an unreadable approvals file must fail closed",
    );
  });

  it("gates a delegated repository review the same way, and releases it on approval", async () => {
    // A review request is the same shape of inbound work as a task: a remote
    // teammate asking this agent to go and do something.
    const requested = await alice.requestReview("gate", {
      reviewer: "bob-claude",
      repo: "github.com/acme/payments",
      baseRev: "1".repeat(40),
      headRev: "2".repeat(40),
      summary: "Review the refund idempotency change.",
    });
    const reviewId = requested.header.review?.id as string;
    await bob.sync();

    const error = await bob
      .updateReview("gate", reviewId, { state: "claimed", body: "Starting the review." })
      .then(() => null)
      .catch((e: unknown) => e);
    assert.ok(error instanceof ApprovalRequiredError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.kind, "review");
    assert.equal(error.requester, "alice-codex");
    assert.match(error.message, /oguri review approve gate/);

    await bob.approveInboundWork("review", "gate", reviewId);
    const claimed = await bob.updateReview("gate", reviewId, {
      state: "claimed",
      body: "Starting the review.",
    });
    assert.equal(claimed.header.review?.state, "claimed");
  });

  it("does not gate reporting findings once the review is under way", async () => {
    // Only taking work on is gated. An agent already doing the work must not
    // need a second approval to say what it found.
    const requested = await alice.requestReview("gate", {
      reviewer: "bob-claude",
      repo: "github.com/acme/payments",
      baseRev: "3".repeat(40),
      headRev: "4".repeat(40),
      summary: "Second review.",
    });
    const reviewId = requested.header.review?.id as string;
    await bob.sync();

    const reported = await bob.updateReview("gate", reviewId, {
      state: "reported",
      body: "No blocking findings.",
    });
    assert.equal(reported.header.review?.state, "reported");
  });

  it("reads a policy set once for the machine from a provisioned agent home", async () => {
    // <root>/agents/<id> is what `oguri agent add` creates.
    const root = join(tmp, "machine");
    const home = join(root, "agents", "carol-codex");
    await mkdir(home, { recursive: true });
    await writeFile(join(root, "policy.yaml"), "v: 1\napprovals:\n  inboundWork: always\n");

    const carol = (
      await Network.init({
        layout: new Layout(home),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "carol-codex" }),
      })
    ).network;
    try {
      const { policy, sources } = await carol.policy();
      assert.equal(policy.approvals.inboundWork, "always");
      assert.deepEqual(sources, [join(root, "policy.yaml")]);
    } finally {
      carol.close();
    }
  });
});
