import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSuperagentPolicy } from "@oguri/core";

import { RouteError, parseRouteDecision, type RouteScope } from "../src/decision.ts";
import { isBigRequest } from "../src/big.ts";
import { isSmallRequest } from "../src/small.ts";
import { BIG_KINDS, COORDINATOR_KINDS, SMALL_KINDS } from "../src/act.ts";
import { buildRules } from "../src/prompt.ts";

/**
 * The code that checks a superagent's model (ADR 0031). The model's reply is
 * data: anything it names that it was not shown, or a kind its role may not
 * choose, refuses the whole decision.
 */

const TASK = "01K0000000000000000000000A";
const ENDED = "01K0000000000000000000000B";
const CANCELLED = "01K0000000000000000000000C";
const STUCK = "01K0000000000000000000000D";
const RUNNING = "01K0000000000000000000000E";

const scope: RouteScope = {
  kinds: BIG_KINDS,
  rooms: ["superagent"],
  targets: ["box-claude", "machine:box"],
  capabilities: ["gpu"],
  tasks: [
    { id: TASK, open: true, state: "open", dependsOn: [] },
    { id: ENDED, open: false, state: "completed" },
    { id: CANCELLED, open: false, state: "cancelled" },
    { id: STUCK, open: true, state: "open", dependsOn: [CANCELLED, TASK] },
    { id: RUNNING, open: true, state: "in_progress", dependsOn: [] },
  ],
  mayAnswer: true,
  maxSteps: 8,
};

const accept = {
  kind: "accept",
  title: "Rename the save button",
  room: "superagent",
  target: "box-claude",
  acknowledgement: "On it.",
  reason: "asked",
};

function refused(raw: unknown, pattern: RegExp, s: RouteScope = scope): void {
  assert.throws(
    () => parseRouteDecision(raw, s),
    (error: unknown) => error instanceof RouteError && pattern.test(error.message),
  );
}

describe("parseRouteDecision", () => {
  it("reads a decision from a fenced block inside a Claude JSON envelope", () => {
    const text = JSON.stringify({
      type: "result",
      result: "```json\n" + JSON.stringify(accept) + "\n```",
    });
    const decision = parseRouteDecision(text, scope);
    assert.equal(decision.kind, "accept");
    assert.equal(decision.kind === "accept" ? decision.target : "", "box-claude");
  });

  it("refuses what the snapshot did not show", () => {
    refused({ ...accept, target: "machine:moon" }, /target 'machine:moon' is not on the roster/);
    refused({ ...accept, room: "prod" }, /room 'prod'/);
    refused({ ...accept, requires: ["tpu"] }, /capability 'tpu'/);
    refused(
      { kind: "attach", taskId: "01K0000000000000000000000Z", reason: "x" },
      /was not in the snapshot/,
    );
  });

  it("refuses a worker no machine would pick up, unless the role has a default machine", () => {
    const { target: _target, ...unaddressed } = accept;
    refused(unaddressed, /names no target or required capability/);
    assert.equal(parseRouteDecision({ ...unaddressed, requires: ["gpu"] }, scope).kind, "accept");
    assert.equal(
      parseRouteDecision(unaddressed, { ...scope, defaultTarget: "machine:box" }).kind,
      "accept",
    );
  });

  it("refuses to stop or move a worker that already ended", () => {
    refused({ kind: "stop", taskId: ENDED, reason: "x" }, /already ended/);
    refused(
      { kind: "retarget", taskId: ENDED, target: "machine:box", reason: "x" },
      /already ended/,
    );
    assert.equal(
      parseRouteDecision({ kind: "attach", taskId: ENDED, reason: "x" }, scope).kind,
      "attach",
    );
  });

  it("reads a relink that drops a cancelled dependency", () => {
    const decision = parseRouteDecision(
      { kind: "relink", taskId: STUCK, removeDependsOn: [CANCELLED], reason: "not needed" },
      scope,
    );
    assert.deepEqual(decision, {
      kind: "relink",
      taskId: STUCK,
      addDependsOn: [],
      removeDependsOn: [CANCELLED],
      reason: "not needed",
    });
    assert.equal(
      parseRouteDecision(
        {
          kind: "relink",
          taskId: STUCK,
          addDependsOn: [ENDED],
          removeDependsOn: [CANCELLED],
          reason: "x",
        },
        scope,
      ).kind,
      "relink",
    );
  });

  it("refuses a relink that cannot work", () => {
    refused({ kind: "relink", taskId: STUCK, reason: "x" }, /at least one task/);
    refused(
      { kind: "relink", taskId: RUNNING, removeDependsOn: [CANCELLED], reason: "x" },
      /already started or ended/,
    );
    refused(
      { kind: "relink", taskId: ENDED, addDependsOn: [TASK], reason: "x" },
      /already started or ended/,
    );
    refused(
      { kind: "relink", taskId: STUCK, removeDependsOn: [ENDED], reason: "x" },
      /is not a dependency of task/,
    );
    refused(
      { kind: "relink", taskId: STUCK, addDependsOn: ["01K0000000000000000000000Z"], reason: "x" },
      /was not in the snapshot/,
    );
    refused({ kind: "relink", taskId: STUCK, addDependsOn: [STUCK], reason: "x" }, /itself/);
    refused(
      {
        kind: "relink",
        taskId: STUCK,
        addDependsOn: [ENDED],
        removeDependsOn: [ENDED],
        reason: "x",
      },
      /both added and removed/,
    );
    refused(
      {
        kind: "relink",
        taskId: "01K0000000000000000000000Z",
        removeDependsOn: [TASK],
        reason: "x",
      },
      /was not in the snapshot/,
    );
  });

  it("reads a replacement only for a cancelled task", () => {
    const decision = parseRouteDecision(
      {
        kind: "replace",
        taskId: CANCELLED,
        title: "Redo the migration",
        target: "box-claude",
        reason: "still needed",
      },
      scope,
    );
    assert.equal(decision.kind === "replace" ? decision.taskId : "", CANCELLED);
    refused(
      { kind: "replace", taskId: TASK, title: "Redo", target: "box-claude", reason: "x" },
      /is not cancelled/,
    );
    refused(
      { kind: "replace", taskId: CANCELLED, title: "Redo", target: "machine:moon", reason: "x" },
      /not on the roster/,
    );
    const { target: _target, ...unaddressed } = {
      kind: "replace",
      taskId: CANCELLED,
      title: "Redo",
      target: "box-claude",
      reason: "x",
    };
    refused(unaddressed, /names no target or required capability/);
  });

  it("reads a request for a person to authorize a runner, and nothing more", () => {
    const decision = parseRouteDecision(
      {
        kind: "request_runner",
        runner: "codex-high",
        machine: "machine:box",
        taskId: TASK,
        reason: "the task needs it",
      },
      scope,
    );
    assert.equal(decision.kind, "request_runner");
    assert.equal(decision.kind === "request_runner" ? decision.runner : "", "codex-high");
    refused({ kind: "request_runner", runner: "Not A Runner!", reason: "x" }, /not a runner name/);
    refused({ kind: "request_runner", reason: "x" }, /'runner' is missing/);
    refused(
      { kind: "request_runner", runner: "codex", machine: "machine:moon", reason: "x" },
      /not on the roster/,
    );
    refused(
      {
        kind: "request_runner",
        runner: "codex",
        taskId: "01K0000000000000000000000Z",
        reason: "x",
      },
      /was not in the snapshot/,
    );
    refused(
      {
        kind: "request_runner",
        runner: "codex",
        reason: "token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
      },
      /secret/,
    );
  });

  it("offers the new decisions to Big and to coordination, but not to a small superagent", () => {
    for (const kind of ["relink", "replace", "request_runner"] as const) {
      assert.ok(BIG_KINDS.includes(kind), `Big can ${kind}`);
      assert.ok(COORDINATOR_KINDS.includes(kind), `coordination can ${kind}`);
      assert.ok(!SMALL_KINDS.includes(kind), `a small superagent cannot ${kind}`);
    }
    refused(
      { kind: "relink", taskId: STUCK, removeDependsOn: [CANCELLED], reason: "x" },
      /not a decision this superagent may make/,
      { ...scope, kinds: SMALL_KINDS },
    );
  });

  it("refuses a kind the role may not choose", () => {
    refused({ ...accept }, /not a decision this superagent may make/, {
      ...scope,
      kinds: COORDINATOR_KINDS,
    });
    refused(
      { kind: "retarget", taskId: TASK, target: "machine:box", reason: "x" },
      /not a decision this superagent may make/,
      { ...scope, kinds: SMALL_KINDS },
    );
  });

  it("refuses a plan with unknown dependencies or a cycle", () => {
    const step = (key: string, dependsOn: string[]) => ({
      key,
      title: key,
      body: "do it",
      dependsOn,
      target: "machine:box",
    });
    const plan = {
      kind: "plan",
      title: "Two",
      room: "superagent",
      acknowledgement: "ok",
      reason: "x",
    };
    refused({ ...plan, steps: [step("a", ["b"]), step("b", ["a"])] }, /cycle/);
    refused({ ...plan, steps: [step("a", ["nope"]), step("b", [])] }, /unknown 'nope'/);
    refused({ ...plan, steps: [step("a", [])] }, /at least two steps/);
    const ok = parseRouteDecision({ ...plan, steps: [step("a", []), step("b", ["a"])] }, scope);
    assert.equal(ok.kind === "plan" ? ok.steps.length : 0, 2);
  });

  it("refuses text that carries a secret, and anything that is not one JSON object", () => {
    refused(
      { kind: "answer", text: "use ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", reason: "x" },
      /secret/,
    );
    refused("I think we should deploy it.", /not one JSON object/);
    refused({ kind: "launch" }, /'kind' must be one of/);
  });

  it("keeps acknowledgements short", () => {
    refused({ ...accept, acknowledgement: "word ".repeat(60) }, /longer than 40 words/);
  });
});

describe("Big's rules keep the work moving", () => {
  const rules = (role: "big" | "small" | "coordinator") =>
    buildRules({
      role,
      kinds: BIG_KINDS,
      allKinds: role === "small" ? SMALL_KINDS : BIG_KINDS,
      self: "alice-big",
      defaultRoom: "superagent",
      maxSteps: 8,
    });

  it("says an unset budget is not a ban, and only an explicit hard limit stops work", () => {
    const text = rules("big");
    assert.match(text, /budget that is not set is not a ban/i);
    assert.match(text, /explicit hard limit/);
  });

  it("deploys a missing executor itself, and asks for a missing runner instead of waiting", () => {
    const text = rules("big");
    assert.match(text, /deploy one yourself with accept or plan/);
    assert.match(text, /request_runner to ask the owner/);
    assert.match(text, /do not stop other work that does not need that runner/);
  });

  it("makes every block end in an action, and names the three ways out of a cancelled dependency", () => {
    const text = rules("big");
    assert.match(text, /the decision itself is the next step/);
    assert.match(text, /relink to drop it, replace to rebuild/);
    assert.match(text, /leaving it is never a decision/);
  });

  it("describes the new decisions with the fields the parser reads", () => {
    const text = rules("big");
    assert.match(text, /- relink:[\s\S]*removeDependsOn[\s\S]*addDependsOn/);
    assert.match(text, /- replace:[\s\S]*taskId \(the cancelled task\)/);
    assert.match(text, /- request_runner:[\s\S]*it does not authorize anything/);
  });

  it("does not hand a small superagent the big one's rules or its new decisions", () => {
    const text = rules("small");
    assert.doesNotMatch(text, /Keep the work moving/);
    assert.doesNotMatch(text, /budget that is not set/);
  });
});

describe("who a superagent listens to", () => {
  const state = { handled: [] as string[], since: "2026-01-01T00:00:00.000Z" };
  const message = (tags: string[], mentions: string[] = [], ts = "2026-06-01T00:00:00.000Z") =>
    ({ header: { id: "01K0000000000000000000000C", tags, mentions, ts } }) as never;

  it("the big superagent takes messages tagged for it, never its own replies or old ones", () => {
    assert.equal(isBigRequest(message(["to-big"]), state), true);
    assert.equal(isBigRequest(message(["to-big", "from-superagent"]), state), false);
    assert.equal(isBigRequest(message(["to-small"]), state), false);
    assert.equal(isBigRequest(message(["to-big"], [], "2025-01-01T00:00:00.000Z"), state), false);
    assert.equal(
      isBigRequest(message(["to-big"]), { ...state, handled: ["01K0000000000000000000000C"] }),
      false,
    );
  });

  it("a small superagent takes only messages that name it", () => {
    assert.equal(isSmallRequest(message(["to-small"], ["box-claude"]), "box-claude", state), true);
    assert.equal(isSmallRequest(message(["to-small"], ["other"]), "box-claude", state), false);
    assert.equal(isSmallRequest(message(["to-big"], ["box-claude"]), "box-claude", state), false);
  });
});

describe("the superagent policy", () => {
  it("lets the small superagent run up to 20 workers, 3 by default", () => {
    assert.equal(parseSuperagentPolicy({}, "policy.yaml").small.maxWorkers, 3);
    assert.equal(parseSuperagentPolicy({ small: { maxWorkers: 20 } }, "p").small.maxWorkers, 20);
    assert.throws(() => parseSuperagentPolicy({ small: { maxWorkers: 21 } }, "p"), /1 to 20/);
  });

  it("is off by default and checks every key", () => {
    const parsed = parseSuperagentPolicy({}, "policy.yaml");
    assert.equal(parsed.big.enabled, false);
    assert.equal(parsed.small.enabled, false);
    assert.equal(parsed.big.room, "superagent");
    assert.throws(
      () => parseSuperagentPolicy({ big: { enabeld: true } }, "policy.yaml"),
      /unknown key 'superagent.big.enabeld'/,
    );
    assert.throws(
      () => parseSuperagentPolicy({ small: { big: "Not An Id" } }, "policy.yaml"),
      /agent id/,
    );
    assert.throws(() => parseSuperagentPolicy({ big: { room: "main" } }, "policy.yaml"), /room id/);
  });
});
