import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_WORKER_POLICY, parseLocalPolicy, type WorkerPolicy } from "../src/policy.ts";
import {
  escalationFor,
  parseTaskHeader,
  renderTaskHeader,
  resolveTier,
  runnerAvailability,
  type RunnerGate,
} from "../src/tiers.ts";

/**
 * Runner tiers (ADR 0034): a tier only groups runners the owner already
 * listed, a request that cannot be honoured is refused with its reason rather
 * than run on something else, and a failed task climbs at most as far as the
 * policy allows.
 */

const RUNNERS = `    cheap:
      argv: [claude, -p]
      model: my-cheap-model
    codexm:
      argv: [codex, exec, '-']
      model: example-codex-model
    small:
      argv: [claude, -p]
      model: sonnet
      efforts: [low, medium, high, max]
    strong:
      argv: [claude, -p]
      model: opus
      efforts: [low, medium, high, max]
`;

function parse(tiers: string, extra = ""): WorkerPolicy {
  const parsed = parseLocalPolicy(
    `worker:\n  runners:\n${RUNNERS}  tiers:\n${tiers}${extra}`,
    "p.yaml",
  );
  return parsed.worker as WorkerPolicy;
}

const LADDER = `    cheap: [cheap, codexm]
    standard:
      runners: small
      effort: medium
    strong:
      runners: [strong]
      effort: high
`;

describe("worker.tiers in the policy", () => {
  it("reads a ladder in every form, cheapest first", () => {
    const worker = parse(LADDER, "  escalation:\n    maxSteps: 2\n");
    assert.deepEqual(worker.tiers, [
      { name: "cheap", runners: ["cheap", "codexm"] },
      { name: "standard", runners: ["small"], effort: "medium" },
      { name: "strong", runners: ["strong"], effort: "high" },
    ]);
    assert.deepEqual(worker.escalation, { maxSteps: 2 });
  });

  it("is off unless written: no tiers, no climbing", () => {
    const worker = parseLocalPolicy(`worker:\n  runners:\n${RUNNERS}`, "p.yaml")
      .worker as WorkerPolicy;
    assert.deepEqual(worker.tiers, []);
    assert.deepEqual(worker.escalation, { maxSteps: 0 });
    assert.deepEqual(DEFAULT_WORKER_POLICY.tiers, []);
  });

  it("refuses a tier that names anything but an existing runner", () => {
    assert.throws(
      () => parse("    cheap: [cheap, missing]\n"),
      /"missing".*not an entry of worker\.runners/,
    );
    assert.throws(() => parse("    cheap: []\n"), /must list at least one/);
    assert.throws(() => parse("    cheap: [--model]\n"), /not an entry of worker\.runners/);
    assert.throws(() => parse("    Cheap: [cheap]\n"), /invalid name 'Cheap'/);
    assert.throws(
      () => parse("    cheap:\n      runner: cheap\n"),
      /unknown key 'worker\.tiers\.cheap\.runner'/,
    );
    assert.throws(
      () => parse("    cheap: [cheap]\n    standard: [cheap]\n"),
      /'cheap', which is already in tier 'cheap'/,
    );
  });

  it("refuses a tier effort a runner in it does not list", () => {
    assert.throws(
      () => parse("    strong:\n      runners: [strong, cheap]\n      effort: high\n"),
      /'high' is not on worker\.runners\.cheap\.efforts \(none\)/,
    );
    assert.throws(
      () => parse("    strong:\n      runners: [strong]\n      effort: '--danger'\n"),
      /must be an effort level/,
    );
  });

  it("bounds escalation, and refuses it with nothing to climb", () => {
    assert.throws(
      () => parse("    cheap: [cheap]\n", "  escalation:\n    maxSteps: 1\n"),
      /needs at least two worker\.tiers/,
    );
    assert.throws(
      () => parse(LADDER, "  escalation:\n    maxSteps: 99\n"),
      /escalation\.maxSteps must be an integer from 0 to 7/,
    );
    assert.throws(() => parse(LADDER, "  escalation:\n    steps: 1\n"), /unknown key/);
  });
});

describe("resolving a tier", () => {
  const worker = parse(LADDER, "  escalation:\n    maxSteps: 1\n");

  it("lands only on a runner of the tier", () => {
    assert.deepEqual(resolveTier(worker, { tier: "cheap" }), { tier: "cheap", runner: "cheap" });
    assert.deepEqual(resolveTier(worker, { tier: "cheap", runner: "codexm" }), {
      tier: "cheap",
      runner: "codexm",
    });
    assert.deepEqual(resolveTier(worker, { tier: "strong" }), {
      tier: "strong",
      runner: "strong",
      effort: "high",
    });
    assert.deepEqual(resolveTier(worker, { tier: "strong", effort: "max" }), {
      tier: "strong",
      runner: "strong",
      effort: "max",
    });
  });

  it("refuses an unknown tier, or a runner outside it, and says why", () => {
    const unknown = resolveTier(worker, { tier: "premium" });
    assert.ok("error" in unknown);
    assert.match(
      unknown.error,
      /tier 'premium' is not configured here \(worker\.tiers: cheap, standard, strong\)/,
    );
    const outside = resolveTier(worker, { tier: "cheap", runner: "strong" });
    assert.ok("error" in outside);
    assert.match(outside.error, /runner 'strong' is not in tier 'cheap' \(cheap, codexm\)/);
    const none = resolveTier({ ...worker, tiers: [] }, { tier: "cheap" });
    assert.ok("error" in none);
    assert.match(none.error, /worker\.tiers is not configured here/);
  });

  it("asks the gate, never swaps a refused runner the requester named", () => {
    // The gate stands in for the runner grants another change is building.
    const noCheap: RunnerGate = (name) =>
      name === "cheap" ? { ok: false, reason: "cheap is not granted here" } : { ok: true };
    // Unnamed: the next runner of the same tier, never another tier.
    assert.deepEqual(resolveTier(worker, { tier: "cheap" }, noCheap), {
      tier: "cheap",
      runner: "codexm",
    });
    // Named: refused with the reason, not replaced.
    const named = resolveTier(worker, { tier: "cheap", runner: "cheap" }, noCheap);
    assert.ok("error" in named);
    assert.match(named.error, /cheap is not granted here/);
    // Nobody in the tier: every reason, and no fallback to another tier.
    const nobody: RunnerGate = () => ({ ok: false, reason: "not granted" });
    const empty = resolveTier(worker, { tier: "cheap" }, nobody);
    assert.ok("error" in empty);
    assert.match(empty.error, /no runner of tier 'cheap' can run here: not granted; not granted/);
  });

  it("lets a gate narrow the allow-list, never widen it", () => {
    const everything: RunnerGate = () => ({ ok: true });
    const unlisted = runnerAvailability(worker, "bash", everything);
    assert.equal(unlisted.ok, false);
  });
});

describe("climbing a tier after a failure", () => {
  const worker = parse(LADDER, "  escalation:\n    maxSteps: 1\n");

  it("moves one tier up, at most maxSteps times, and stops at the top", () => {
    assert.deepEqual(escalationFor(worker, { tier: "cheap", escalated: 0 }), {
      tier: "standard",
      runner: "small",
      effort: "medium",
      step: 1,
    });
    const capped = escalationFor(worker, { tier: "standard", escalated: 1 });
    assert.match("stay" in capped ? capped.stay : "", /limit of worker\.escalation\.maxSteps/);
    const roomy = { ...worker, escalation: { maxSteps: 5 } };
    const top = escalationFor(roomy, { tier: "strong", escalated: 1 });
    assert.match("stay" in top ? top.stay : "", /'strong' is the top tier/);
  });

  it("never moves a task that pinned its runner, or with climbing off", () => {
    const pinned = escalationFor(worker, { escalated: 0 });
    assert.match("stay" in pinned ? pinned.stay : "", /names its runner rather than a tier/);
    const off = escalationFor(
      { ...worker, escalation: { maxSteps: 0 } },
      {
        tier: "cheap",
        escalated: 0,
      },
    );
    assert.match("stay" in off ? off.stay : "", /worker\.escalation is off/);
  });

  it("does not climb onto a runner the gate refuses", () => {
    const noSmall: RunnerGate = (name) =>
      name === "small" ? { ok: false, reason: "small is not granted" } : { ok: true };
    const held = escalationFor(worker, { tier: "cheap", escalated: 0 }, noSmall);
    assert.match("stay" in held ? held.stay : "", /small is not granted/);
  });
});

describe("the task header", () => {
  it("round-trips, and ends with a blank line so the owner's text is never a header", () => {
    const text = renderTaskHeader({
      runner: "sonnet",
      effort: "medium",
      tier: "standard",
      reason: "touches\nthree packages",
      escalated: 1,
    });
    assert.equal(
      text,
      "runner: sonnet\neffort: medium\ntier: standard\ntier-reason: touches three packages\nescalated: 1\n\n",
    );
    const parsed = parseTaskHeader(`${text}tier: strong\nDo it.`);
    assert.deepEqual(parsed, {
      runner: "sonnet",
      effort: "medium",
      tier: "standard",
      tierReason: "touches three packages",
      escalated: 1,
      prompt: "tier: strong\nDo it.",
    });
    assert.equal(renderTaskHeader({}), "");
  });

  it("reports a malformed tier line rather than ignoring it", () => {
    const parsed = parseTaskHeader("tier: strong --dangerously-skip-permissions\nDo it.");
    assert.equal(parsed.tier, undefined);
    assert.match(parsed.refusedTier ?? "", /malformed/);
    assert.equal(parsed.prompt, "tier: strong --dangerously-skip-permissions\nDo it.");
  });
});
