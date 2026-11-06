import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunnerGate, WorkerPolicy, WorkerRunner } from "@oguri/core";

import { escalateCandidate } from "../src/escalate.ts";
import { followupEffort } from "../src/followup.ts";
import type { Executor, RunRequest } from "../src/runner.ts";
import { listRuns } from "../src/runs.ts";
import { parseRunnerHint, selectCandidates } from "../src/select.ts";
import { Worker } from "../src/worker.ts";
import { ME, fakeBackend, policy, result, threadMessage, type FakeTask } from "./fake-backend.ts";

/**
 * Tiers on the worker (ADR 0034): a task's tier lands only on a runner the
 * owner listed in that tier, a tier that cannot run here is refused with its
 * reason, a failed run climbs a bounded number of tiers, and a follow-up may
 * ask for its own effort.
 */

const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const ID_C = "01JCCCCCCCCCCCCCCCCCCCCCCC";
const SESSION = "5f0c6a1e-1111-4222-8333-944445555666";

const claude = (model: string, efforts?: string[]): WorkerRunner => ({
  argv: ["claude", "-p", "--output-format", "json"],
  resume: ["claude", "-p", "--output-format", "json", "--resume", "{session}"],
  session: "claude-json",
  model,
  ...(efforts === undefined ? {} : { efforts }),
  worktree: false,
});

const RUNNERS: Record<string, WorkerRunner> = {
  cheap: claude("my-cheap-model"),
  codexm: { argv: ["codex", "exec", "-"], model: "example-codex-model", worktree: false },
  small: claude("sonnet", ["low", "medium", "high", "max"]),
  strong: claude("opus", ["low", "medium", "high", "max"]),
};

function tiered(overrides: Partial<WorkerPolicy> = {}): WorkerPolicy {
  return policy({
    runners: RUNNERS,
    defaultRunner: "cheap",
    tiers: [
      { name: "cheap", runners: ["cheap", "codexm"] },
      { name: "standard", runners: ["small"], effort: "medium" },
      { name: "strong", runners: ["strong"], effort: "high" },
    ],
    escalation: { maxSteps: 1 },
    ...overrides,
  });
}

function agendaOf(tasks: FakeTask[]) {
  return {
    entries: tasks.map((t) => ({
      room: "ops",
      relation: "offered",
      ready: true,
      status: {
        task: { id: t.id, title: t.title ?? "t", creator: "alice-claude", state: "open" },
        definition: t.definition,
        priority: t.priority ?? "normal",
        thread: t.id,
        waitingOn: [],
        children: [],
      },
    })),
  } as never;
}

/** Every part of an argv must come from the policy: never from task text. */
function fromPolicy(argv: readonly string[]): boolean {
  const allowed = new Set<string>([
    "--model",
    "--effort",
    "-m",
    ...Object.values(RUNNERS).flatMap((r) => [
      ...r.argv,
      ...(r.model === undefined ? [] : [r.model]),
      ...(r.efforts ?? []),
    ]),
  ]);
  return argv.every((part) => allowed.has(part));
}

describe("selecting by tier", () => {
  it("lands a tier only on a runner of that tier, at the tier's effort", () => {
    const { candidates, skipped } = selectCandidates(
      agendaOf([
        { id: ID_A, definition: "tier: cheap\ntier-reason: a one-line rename\nRename it." },
        { id: ID_B, definition: "tier: strong\nRework the scheduler." },
        { id: ID_C, definition: "runner: codexm\ntier: cheap\nRename it." },
      ]),
      tiered(),
    );
    assert.deepEqual(skipped, []);
    const [a, b, c] = candidates;
    assert.equal(a?.runner, "cheap");
    assert.equal(a?.tier, "cheap");
    assert.equal(a?.tierReason, "a one-line rename");
    assert.equal(a?.prompt, "Rename it.");
    assert.deepEqual(a?.argv, [...RUNNERS["cheap"]!.argv, "--model", "my-cheap-model"]);
    assert.equal(b?.runner, "strong");
    assert.deepEqual(b?.argv.slice(-4), ["--model", "opus", "--effort", "high"]);
    assert.equal(b?.effortSource, "tier", "the tier chose the level, not a line in the task");
    assert.equal(c?.runner, "codexm");
    for (const candidate of candidates)
      assert.ok(fromPolicy(candidate.argv), candidate.argv.join(" "));
  });

  it("refuses an unknown tier, a runner outside its tier, or a malformed tier line", () => {
    const { candidates, skipped } = selectCandidates(
      agendaOf([
        { id: ID_A, definition: "tier: premium\nDo it." },
        { id: ID_B, definition: "runner: strong\ntier: cheap\nDo it." },
        { id: ID_C, definition: "tier: strong; rm -rf ~\nDo it." },
      ]),
      tiered(),
    );
    assert.deepEqual(candidates, [], "nothing runs on a substitute runner");
    assert.match(skipped[0]?.reason ?? "", /tier 'premium' is not configured here/);
    assert.match(skipped[1]?.reason ?? "", /runner 'strong' is not in tier 'cheap'/);
    assert.match(skipped[2]?.reason ?? "", /malformed/);
  });

  it("refuses, with the gate's reason, a tier whose runners may not run here", () => {
    const gate: RunnerGate = (name) =>
      name === "strong"
        ? { ok: false, reason: "strong is not granted on this machine" }
        : { ok: true };
    const { candidates, skipped } = selectCandidates(
      agendaOf([
        { id: ID_A, definition: "tier: strong\nDo it." },
        { id: ID_B, definition: "runner: strong\nDo it." },
      ]),
      tiered(),
      new Set(),
      gate,
    );
    assert.deepEqual(candidates, []);
    assert.match(skipped[0]?.reason ?? "", /strong is not granted on this machine/);
    assert.match(skipped[1]?.reason ?? "", /strong is not granted on this machine/);
  });

  it("never lets header text reach the argv", () => {
    for (const definition of [
      "tier: cheap --dangerously-skip-permissions\nx",
      "tier: cheap\neffort: max\nx",
      "tier: strong\neffort: --tools=all\nx",
      "tier-reason: --model evil\ntier: cheap\nx",
      "escalated: 99\ntier: cheap\nx",
      "tier: cheap\nrunner: bash\nx",
    ]) {
      const { candidates } = selectCandidates(agendaOf([{ id: ID_A, definition }]), tiered());
      for (const candidate of candidates) {
        assert.ok(fromPolicy(candidate.argv), `${definition} → ${candidate.argv.join(" ")}`);
      }
    }
  });

  it("leaves a task with no tier exactly as before", () => {
    const { candidates } = selectCandidates(
      agendaOf([{ id: ID_A, definition: "Do it." }]),
      tiered(),
    );
    assert.equal(candidates[0]?.runner, "cheap");
    assert.equal(candidates[0]?.tier, undefined);
  });
});

describe("climbing after a failure", () => {
  const candidate = {
    tier: "cheap",
    runner: "cheap",
    prompt: "Rename it.",
  };

  it("writes the next tier as a header the worker reads back", () => {
    const step = escalateCandidate(tiered(), candidate);
    assert.ok("definition" in step);
    assert.equal(step.tier, "standard");
    assert.equal(step.runner, "small");
    const header = parseRunnerHint(step.definition);
    assert.equal(header.tier, "standard");
    assert.equal(header.runner, "small");
    assert.equal(header.effort, "medium");
    assert.equal(header.escalated, 1);
    assert.match(header.tierReason ?? "", /moved up from tier cheap/);
    assert.equal(header.prompt, "Rename it.");
  });

  it("stops at maxSteps, so the second failure does not climb again", () => {
    const step = escalateCandidate(tiered(), { ...candidate, tier: "standard", escalated: 1 });
    assert.ok("stay" in step);
    assert.match(step.stay, /limit of worker\.escalation\.maxSteps/);
  });

  it("refines the task one tier up, then releases it, on a failed run", async () => {
    const tasks: FakeTask[] = [{ id: ID_A, definition: "tier: cheap\nRename it.", maxAttempts: 2 }];
    const fake = fakeBackend(tasks);
    const home = await mkdtemp(join(tmpdir(), "oguri-tiers-"));
    const w = new Worker({
      backend: fake.backend,
      agentId: ME,
      machineId: "build-01",
      home,
      loadPolicy: async () => tiered({ workdir: home }),
      executor: async () => result({ exitCode: 1 }),
    });
    await w.pass();
    await w.idle();
    const actions = fake.updates().map((u) => u.action);
    assert.deepEqual(actions, ["started", "refined", "released"]);
    const refined = fake.updates().find((u) => u.action === "refined");
    assert.match(refined?.body ?? "", /^runner: small\neffort: medium\ntier: standard\n/);
    assert.match(refined?.body ?? "", /escalated: 1/);
    const released = fake.updates().find((u) => u.action === "released");
    assert.match(released?.body ?? "", /one tier up: tier standard, runner small/);
    const [run] = await listRuns(home);
    assert.equal(run?.tier, "cheap");
    assert.deepEqual(run?.escalatedTo, { tier: "standard", runner: "small", step: 1 });
    assert.equal(run?.modelRequested, "my-cheap-model", "the failed run's own request");
  });

  it("does not move a task that pinned its runner", async () => {
    const tasks: FakeTask[] = [
      { id: ID_A, definition: "runner: cheap\nRename it.", maxAttempts: 2 },
    ];
    const fake = fakeBackend(tasks);
    const home = await mkdtemp(join(tmpdir(), "oguri-tiers-"));
    const w = new Worker({
      backend: fake.backend,
      agentId: ME,
      home,
      loadPolicy: async () => tiered({ workdir: home }),
      executor: async () => result({ exitCode: 1 }),
    });
    await w.pass();
    await w.idle();
    assert.deepEqual(
      fake.updates().map((u) => u.action),
      ["started", "released"],
    );
  });
});

describe("a follow-up's own effort", () => {
  it("reads an effort line from a person's message, and only that", () => {
    assert.deepEqual(followupEffort("effort: max\nThink harder this time."), {
      effort: "max",
      text: "Think harder this time.",
    });
    // A follow-up keeps its session's runner: these are just words.
    assert.deepEqual(followupEffort("runner: strong\neffort: max\nGo."), {
      text: "runner: strong\neffort: max\nGo.",
    });
    assert.deepEqual(followupEffort("Just text."), { text: "Just text." });
  });

  it("runs the resumed session at the follow-up's level, recorded apart from the first run", async () => {
    const home = await mkdtemp(join(tmpdir(), "oguri-tiers-"));
    const tasks: FakeTask[] = [
      { id: ID_A, title: "Rename", definition: "tier: standard\nRename it." },
    ];
    const fake = fakeBackend(tasks);
    const requests: RunRequest[] = [];
    const executor: Executor = async (request) => {
      requests.push(request);
      const text = JSON.stringify({
        type: "result",
        session_id: SESSION,
        result: "done",
        modelUsage: { sonnet: { costUSD: 1 } },
      });
      await mkdir(request.logDir, { recursive: true });
      await writeFile(join(request.logDir, "stdout.log"), text);
      return result({ stdoutTail: text });
    };
    const w = new Worker({
      backend: fake.backend,
      agentId: ME,
      home,
      loadPolicy: async () => tiered({ workdir: home }),
      executor,
    });
    await w.pass();
    await w.idle();
    tasks[0] = {
      ...tasks[0],
      id: ID_A,
      state: "completed",
      assignee: ME,
      hidden: true,
      events: [{ action: "completed" }],
    };
    fake.byId.set(ID_A, tasks[0]);
    fake.messages.push(
      threadMessage(ID_A, "effort: high\nAlso the cancel button.", {
        ts: new Date(Date.now() + 5).toISOString(),
        external: { actorName: "Bob" },
      }),
    );
    const report = await w.pass();
    await w.idle();
    assert.deepEqual(report.followups, [ID_A]);
    assert.deepEqual(requests[0]?.argv.slice(-2), ["--effort", "medium"]);
    // The resume argv, at the follow-up's own level.
    assert.deepEqual(requests[1]?.argv.slice(-6), [
      "--resume",
      SESSION,
      "--model",
      "sonnet",
      "--effort",
      "high",
    ]);
    // The agent reads the person's words, not the worker's hint.
    assert.match(requests[1]?.prompt ?? "", /Bob: Also the cancel button\./);
    assert.doesNotMatch(requests[1]?.prompt ?? "", /effort: high/);

    const runs = await listRuns(home);
    const first = runs.find((r) => r.followup !== true);
    const second = runs.find((r) => r.followup === true);
    assert.equal(first?.effortRequested, "medium");
    assert.equal(first?.effortSource, "tier");
    assert.equal(second?.effortRequested, "high");
    assert.equal(second?.effortSource, "follow-up");
    // Each run keeps its request apart from what the service named.
    for (const run of [first, second]) {
      assert.equal(run?.modelRequested, "sonnet");
      assert.equal(run?.modelReported, "sonnet");
      assert.equal(run?.modelSource, "result-usage");
    }
  });

  it("refuses a follow-up level the runner does not list, and runs at the task's", async () => {
    const home = await mkdtemp(join(tmpdir(), "oguri-tiers-"));
    const tasks: FakeTask[] = [
      { id: ID_A, title: "Rename", definition: "tier: standard\nRename it." },
    ];
    const fake = fakeBackend(tasks);
    const requests: RunRequest[] = [];
    const log: string[] = [];
    const executor: Executor = async (request) => {
      requests.push(request);
      const text = JSON.stringify({ type: "result", session_id: SESSION, result: "done" });
      await mkdir(request.logDir, { recursive: true });
      await writeFile(join(request.logDir, "stdout.log"), text);
      return result({ stdoutTail: text });
    };
    const w = new Worker({
      backend: fake.backend,
      agentId: ME,
      home,
      loadPolicy: async () => tiered({ workdir: home }),
      executor,
      log: (line) => log.push(line),
    });
    await w.pass();
    await w.idle();
    tasks[0] = {
      ...tasks[0],
      id: ID_A,
      state: "completed",
      assignee: ME,
      hidden: true,
      events: [{ action: "completed" }],
    };
    fake.byId.set(ID_A, tasks[0]);
    fake.messages.push(
      threadMessage(ID_A, "effort: ultra\nAgain.", {
        ts: new Date(Date.now() + 5).toISOString(),
        external: {},
      }),
    );
    await w.pass();
    await w.idle();
    assert.equal(requests[1]?.argv.includes("ultra"), false);
    assert.equal(requests[1]?.argv.at(-1), "medium");
    assert.ok(
      log.some((line) => /effort 'ultra' is not allowed/.test(line)),
      log.join("\n"),
    );
    const second = (await listRuns(home)).find((r) => r.followup === true);
    assert.equal(second?.effortSource, "tier", "the refused level fell back to the task's tier");
  });
});
