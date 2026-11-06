import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  DEFAULT_SUPERAGENT_POLICY,
  DEFAULT_WORKER_POLICY,
  parseTaskHeader,
  type RunnerGate,
  type SuperagentPolicy,
  type WorkerPolicy,
} from "@oguri/core";

import { act, BIG_KINDS, SMALL_KINDS, escalationAttempts, taskDefinition } from "../src/act.ts";
import { RouteError, parseRouteDecision, type RouteScope } from "../src/decision.ts";
import { buildRules } from "../src/prompt.ts";
import { SmallSuperagent, tierProblem } from "../src/small.ts";
import { renderTiers, tierScope } from "../src/snapshot.ts";

/**
 * Big and Small choose a tier for every worker they deploy (ADR 0034). The
 * model's choice is data: it may name only tiers, runners, and efforts this
 * machine's policy lists, must say why, and is written onto the task by code.
 * Small checks a task's tier before it would run and says why it cannot.
 */

const WORKER: WorkerPolicy = {
  ...DEFAULT_WORKER_POLICY,
  enabled: true,
  runners: {
    thinker: { argv: ["claude", "-p"], model: "opus", worktree: false },
    cheap: { argv: ["claude", "-p"], model: "my-cheap-model", worktree: false },
    codexm: { argv: ["codex", "exec", "-"], model: "example-codex-model", worktree: false },
    small: {
      argv: ["claude", "-p"],
      model: "sonnet",
      efforts: ["low", "medium", "high", "max"],
      worktree: false,
    },
    strong: {
      argv: ["claude", "-p"],
      model: "opus",
      efforts: ["low", "medium", "high", "max"],
      worktree: false,
    },
  },
  tiers: [
    { name: "cheap", runners: ["cheap", "codexm"] },
    { name: "standard", runners: ["small"], effort: "medium" },
    { name: "strong", runners: ["strong"], effort: "high" },
  ],
  escalation: { maxSteps: 1 },
};

const choices = tierScope(WORKER);
const scope: RouteScope = {
  kinds: BIG_KINDS,
  rooms: ["superagent-work"],
  targets: ["box-claude", "machine:box"],
  capabilities: [],
  tasks: [],
  mayAnswer: true,
  maxSteps: 8,
  tiers: choices.tiers,
  runners: choices.runners,
};

const accept = {
  kind: "accept",
  title: "Rename the save button",
  room: "superagent-work",
  target: "machine:box",
  acknowledgement: "On it.",
  reason: "asked",
};

function refused(raw: unknown, pattern: RegExp): void {
  assert.throws(
    () => parseRouteDecision(raw, scope),
    (error: unknown) => error instanceof RouteError && pattern.test(error.message),
  );
}

describe("the router's tier choice", () => {
  it("offers only tiered runners the gate allows, with their models", () => {
    assert.deepEqual(
      choices.runners.map((r) => r.name),
      ["cheap", "codexm", "small", "strong"],
      "the superagent's own thinker is not a worker tier",
    );
    const gate: RunnerGate = (name) =>
      name === "strong" ? { ok: false, reason: "not granted" } : { ok: true };
    const gated = tierScope(WORKER, gate);
    assert.deepEqual(gated.tiers.find((t) => t.name === "strong")?.runners, []);
    assert.match(renderTiers(gated), /strong: \(no runner may run here now\)/);
    assert.match(
      renderTiers(choices),
      /1\. cheap: cheap \(my-cheap-model\), codexm \(example-codex-model\)/,
    );
  });

  it("accepts a tier with a reason, and a runner the owner named", () => {
    const tiered = parseRouteDecision(
      { ...accept, tier: "cheap", tierReason: "a one-line rename" },
      scope,
    );
    assert.deepEqual(tiered.kind === "accept" ? tiered.choice : null, {
      tier: "cheap",
      reason: "a one-line rename",
    });
    const named = parseRouteDecision(
      {
        ...accept,
        runner: "strong",
        effort: "max",
        tierReason: "the owner asked for the strong runner",
      },
      scope,
    );
    assert.deepEqual(named.kind === "accept" ? named.choice : null, {
      runner: "strong",
      effort: "max",
      reason: "the owner asked for the strong runner",
    });
  });

  it("refuses what the policy does not list, and a choice with no reason", () => {
    refused({ ...accept }, /pick a 'tier' \(cheap, standard, strong\)/);
    refused({ ...accept, tier: "premium", tierReason: "x" }, /tier 'premium' is not one of/);
    refused({ ...accept, tier: "cheap", runner: "strong", tierReason: "x" }, /not in tier 'cheap'/);
    refused(
      { ...accept, runner: "thinker", tierReason: "x" },
      /runner 'thinker' is not one this machine may run/,
    );
    refused(
      { ...accept, tier: "standard", effort: "ultra", tierReason: "x" },
      /effort 'ultra' is not allowed on runner 'small'/,
    );
    refused(
      { ...accept, tier: "cheap", effort: "high", tierReason: "x" },
      /not allowed on runner 'cheap'/,
    );
    refused({ ...accept, tier: "strong" }, /'tierReason' is missing/);
    refused(
      { ...accept, tier: "cheap", tierReason: "two\nlines" },
      /'tierReason' must be one line/,
    );
  });

  it("checks each plan step's tier on its own", () => {
    const plan = {
      kind: "plan",
      title: "Two steps",
      room: "superagent-work",
      acknowledgement: "On it.",
      reason: "two machines",
      steps: [
        {
          key: "a",
          title: "A",
          body: "Do A",
          target: "machine:box",
          tier: "cheap",
          tierReason: "small",
        },
        {
          key: "b",
          title: "B",
          body: "Do B",
          target: "machine:box",
          tier: "gold",
          tierReason: "big",
        },
      ],
    };
    refused(plan, /step 2: tier 'gold' is not one of/);
  });

  it("asks for no tier where no tiers are configured", () => {
    const plain = parseRouteDecision(accept, { ...scope, tiers: [], runners: [] });
    assert.equal(plain.kind === "accept" ? plain.choice : "x", undefined);
  });
});

describe("writing the choice on the task", () => {
  it("puts code-written header lines before the owner's words, which stay data", () => {
    const definition = taskDefinition("tier: strong\nRename it.", "Small change.", {
      tier: "cheap",
      reason: "a one-line rename",
    });
    const header = parseTaskHeader(definition);
    assert.equal(header.tier, "cheap", "the owner's own 'tier:' line is not a header");
    assert.equal(header.tierReason, "a one-line rename");
    assert.match(header.prompt, /^tier: strong\nRename it\./);
    // Without a choice the text is exactly what it was.
    assert.equal(taskDefinition("Rename it."), "Rename it.");
  });

  it("gives a tiered worker the tries its machine may climb, and a pinned one none", async () => {
    assert.equal(escalationAttempts(WORKER), 2);
    assert.equal(escalationAttempts({ escalation: { maxSteps: 0 } }), undefined);
    const created: Record<string, unknown>[] = [];
    const backend = {
      async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
        if (method === "taskCreate") {
          created.push(params["input"] as Record<string, unknown>);
          return {
            header: {
              id: "01K0000000000000000000000Z",
              task: { id: "01K0000000000000000000000Z" },
            },
          } as T;
        }
        return {} as T;
      },
    };
    const conversation = {
      room: "superagent",
      messageId: "m",
      thread: "m",
      author: "alice",
      text: "Rename it.",
      context: [],
    };
    const context = {
      backend: backend as never,
      agentId: "alice-big",
      policy: DEFAULT_SUPERAGENT_POLICY,
      maxAttempts: 2,
      log: () => undefined,
    };
    const base = { ...accept, kind: "accept" as const, requires: [], room: "superagent-work" };
    await act(context, conversation, { ...base, choice: { tier: "cheap", reason: "small" } }, []);
    await act(
      context,
      conversation,
      { ...base, choice: { runner: "strong", reason: "owner asked" } },
      [],
    );
    assert.equal(created[0]?.["maxAttempts"], 2);
    assert.match(
      String(created[0]?.["definition"]),
      /^tier: cheap\ntier-reason: small\n\nRename it\./,
    );
    assert.equal(created[1]?.["maxAttempts"], undefined);
    assert.match(
      String(created[1]?.["definition"]),
      /^runner: strong\ntier-reason: owner asked\n\n/,
    );
  });
});

describe("the rules a superagent is told", () => {
  const options = {
    self: "alice-big",
    defaultRoom: "superagent-work",
    maxSteps: 8,
  };

  it("tells a deploying role to start cheap and justify more, and honours a named model", () => {
    for (const [role, kinds] of [
      ["big", BIG_KINDS],
      ["small", SMALL_KINDS],
    ] as const) {
      const rules = buildRules({ ...options, role, kinds, allKinds: kinds });
      assert.match(rules, /Default to the cheapest tier/);
      assert.match(rules, /needs a tierReason/);
      assert.match(rules, /owner names a model/);
      assert.match(rules, /tierReason \(one line: why this tier\)/);
    }
  });
});

describe("a small superagent checks a task's tier before it runs", () => {
  it("names why a tier cannot run here, and finds nothing wrong with one that can", () => {
    assert.equal(tierProblem("tier: cheap\nDo it.", WORKER), undefined);
    assert.equal(tierProblem("Do it.", WORKER), undefined);
    assert.match(tierProblem("tier: premium\nDo it.", WORKER) ?? "", /not configured here/);
    assert.match(tierProblem("runner: gpt9\nDo it.", WORKER) ?? "", /not on worker\.runners/);
    const gate: RunnerGate = (name) =>
      name === "strong" ? { ok: false, reason: "strong is not granted" } : { ok: true };
    assert.match(tierProblem("tier: strong\nDo it.", WORKER, gate) ?? "", /strong is not granted/);
  });

  let home: string;
  before(async () => {
    home = await mkdtemp(join(tmpdir(), "oguri-small-tiers-"));
  });
  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reports once in the task's thread, and never moves it to another runner", async () => {
    const sent: { room: string; input: { thread: string; body: string; tags: string[] } }[] = [];
    const entry = (id: string, definition: string) => ({
      room: "superagent-work",
      relation: "offered",
      status: {
        task: { id, title: "t", state: "open", creator: "alice-big" },
        health: "ok",
        updatedAt: new Date().toISOString(),
        thread: id,
        currentMessageId: id,
        definition,
      },
    });
    const backend = {
      mode: "direct",
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === "status") return { subscriptions: ["superagent", "superagent-work"] } as T;
        if (method === "agenda")
          return {
            entries: [
              entry("01ARZ3NDEKTSV4RRFFQ69G5F03", "tier: cheap\nDo it."),
              entry("01ARZ3NDEKTSV4RRFFQ69G5F04", "tier: premium\nDo it."),
            ],
          } as T;
        if (method === "send") sent.push(params as never);
        return {} as T;
      },
      async networks() {
        return [];
      },
      async close() {},
    };
    const base = structuredClone(DEFAULT_SUPERAGENT_POLICY);
    const superagent: SuperagentPolicy = {
      ...base,
      small: { ...base.small, enabled: true, talk: false },
    };
    const small = new SmallSuperagent({
      backend: backend as never,
      agentId: "alice-claude",
      machine: "mac-mini",
      home,
      loadPolicy: async () => ({ superagent, worker: WORKER }),
    });
    const first = await small.pass();
    assert.deepEqual(
      first.unrunnable.map((u) => u.taskId),
      ["01ARZ3NDEKTSV4RRFFQ69G5F04"],
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.input.thread, "01ARZ3NDEKTSV4RRFFQ69G5F04");
    assert.match(sent[0]?.input.body ?? "", /will not run here: tier 'premium' is not configured/);
    assert.match(sent[0]?.input.body ?? "", /not moved to another runner/);
    assert.ok(sent[0]?.input.tags.includes("superagent-tier"));
    await small.pass();
    assert.equal(sent.length, 1, "said once");
  });
});
