import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Message } from "@oguri/protocol";

import {
  MAX_PLAN_TASKS,
  PlanCreateError,
  PlanError,
  createPlanTasks,
  extractPlanJson,
  parsePlan,
  planOrder,
  planSecretProblems,
  validatePlan,
  withDefaultTarget,
  type PlanWriter,
} from "../src/index.ts";
import type { TaskCreateInput } from "../src/network/tasks.ts";

const GOOD = {
  title: "Ship the report",
  tasks: [
    { key: "data", title: "Collect data", body: "Pull last week's numbers." },
    {
      key: "chart",
      title: "Draw charts",
      body: "Plot them.",
      dependsOn: ["data"],
      requires: ["python"],
    },
    {
      key: "write",
      title: "Write it up",
      body: "Summarise.",
      dependsOn: ["data", "chart"],
      target: "machine:build-01",
      maxAttempts: 2,
    },
  ],
};

function problemsOf(raw: unknown): readonly string[] {
  try {
    validatePlan(raw);
  } catch (error) {
    assert.ok(error instanceof PlanError, "expected a PlanError");
    return error.problems;
  }
  assert.fail("expected the plan to be refused");
}

describe("extractPlanJson", () => {
  it("takes the contents of a json fence", () => {
    const reply = 'Here you go:\n```json\n{"title":"t","tasks":[]}\n```\nDone.';
    assert.equal(extractPlanJson(reply), '{"title":"t","tasks":[]}');
  });

  it("takes a bare object after a sentence of chatter", () => {
    assert.equal(extractPlanJson('Sure! {"a":1} hope that helps'), '{"a":1}');
  });

  it("does not stop at a brace inside a string", () => {
    const body = '{"title":"x","tasks":[{"body":"use } and { freely"}]}';
    assert.equal(extractPlanJson(`prefix ${body} suffix`), body);
  });

  it("reports a reply with no object, and one that never closes", () => {
    assert.throws(() => extractPlanJson("no json here"), /no JSON object/);
    assert.throws(() => extractPlanJson('{"title": "open'), /not closed/);
  });
});

describe("validatePlan", () => {
  it("accepts a well-formed plan and keeps its fields", () => {
    const plan = validatePlan(GOOD);
    assert.equal(plan.title, "Ship the report");
    assert.deepEqual(plan.tasks[1]?.requires, ["python"]);
    assert.equal(plan.tasks[2]?.target, "machine:build-01");
    assert.equal(plan.tasks[2]?.maxAttempts, 2);
    assert.deepEqual(plan.tasks[0]?.dependsOn, []);
  });

  it("parses a plan out of a model reply", () => {
    const plan = parsePlan(`Here is the plan:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``);
    assert.equal(plan.tasks.length, 3);
  });

  it("refuses an unknown key, which would silently drop a dependency", () => {
    const bad = { ...GOOD, tasks: [{ key: "a", title: "A", body: "b", depends_on: ["x"] }] };
    assert.match(problemsOf(bad).join("\n"), /unknown key 'depends_on'/);
  });

  it("refuses duplicate keys, unknown dependencies and self dependencies", () => {
    const problems = problemsOf({
      title: "t",
      tasks: [
        { key: "a", title: "A", body: "b" },
        { key: "a", title: "A2", body: "b" },
        { key: "b", title: "B", body: "b", dependsOn: ["ghost", "b"] },
      ],
    }).join("\n");
    assert.match(problems, /used by more than one task/);
    assert.match(problems, /'ghost', which is not a key in this plan/);
    assert.match(problems, /depends on itself/);
  });

  it("reports every problem at once, so one model run can fix them all", () => {
    const problems = problemsOf({
      title: "",
      tasks: [
        { key: "a b", title: "", body: "" },
        { key: "ok", title: "T", body: "b", requires: ["Bad Cap"], maxAttempts: 99 },
      ],
    });
    assert.ok(problems.length >= 5, `expected several problems, got ${problems.join("; ")}`);
  });

  it("refuses a cycle and names the tasks on it", () => {
    const problems = problemsOf({
      title: "t",
      tasks: [
        { key: "a", title: "A", body: "b", dependsOn: ["c"] },
        { key: "b", title: "B", body: "b", dependsOn: ["a"] },
        { key: "c", title: "C", body: "b", dependsOn: ["b"] },
        { key: "d", title: "D", body: "b" },
      ],
    });
    assert.match(problems[0] ?? "", /cycle among: a, b, c/);
    assert.doesNotMatch(problems[0] ?? "", /\bd\b/);
  });

  it("refuses an empty plan, a non-object, a bad target and too many tasks", () => {
    assert.match(problemsOf({ title: "t", tasks: [] }).join(), /non-empty list/);
    assert.match(problemsOf([]).join(), /JSON object/);
    assert.match(
      problemsOf({
        title: "t",
        tasks: [{ key: "a", title: "A", body: "b", target: "Not Valid" }],
      }).join(),
      /not an agent id or machine/,
    );
    const many = Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => ({
      key: `t${String(i)}`,
      title: "T",
      body: "b",
    }));
    assert.match(problemsOf({ title: "t", tasks: many }).join(), /at most 50 tasks/);
  });
});

describe("planOrder", () => {
  it("puts every dependency first and keeps a plan already in order unchanged", () => {
    const plan = validatePlan(GOOD);
    assert.deepEqual(
      planOrder(plan).map((t) => t.key),
      ["data", "chart", "write"],
    );
  });

  it("reorders a plan written out of order, stably", () => {
    const plan = validatePlan({
      title: "t",
      tasks: [
        { key: "last", title: "L", body: "b", dependsOn: ["mid"] },
        { key: "free", title: "F", body: "b" },
        { key: "mid", title: "M", body: "b", dependsOn: ["first"] },
        { key: "first", title: "1", body: "b" },
      ],
    });
    assert.deepEqual(
      planOrder(plan).map((t) => t.key),
      ["free", "first", "mid", "last"],
    );
  });
});

describe("withDefaultTarget", () => {
  it("fills only the steps that name no target", () => {
    const plan = withDefaultTarget(validatePlan(GOOD), "alice-claude");
    assert.equal(plan.tasks[0]?.target, "alice-claude");
    assert.equal(plan.tasks[2]?.target, "machine:build-01");
  });
});

describe("planSecretProblems", () => {
  it("finds a secret anywhere and never repeats it", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const plan = validatePlan({
      title: "t",
      tasks: [{ key: "a", title: "A", body: `export AWS_ACCESS_KEY_ID=${secret}` }],
    });
    const problems = planSecretProblems(plan, "goal");
    assert.ok(problems.length > 0);
    assert.match(problems[0] ?? "", /task 'a' body/);
    assert.ok(!problems.join().includes(secret), "a finding must name where, not what");
  });

  it("passes a clean plan", () => {
    assert.deepEqual(planSecretProblems(validatePlan(GOOD), "make the report"), []);
  });
});

/** A writer that records calls and hands out sequential ids. */
function fakeWriter(options: { failOn?: string; refuseClaim?: boolean } = {}) {
  const created: { input: TaskCreateInput; id: string }[] = [];
  const claims: string[] = [];
  const writer: PlanWriter = {
    createTask: async (_room, input) => {
      if (options.failOn !== undefined && input.title === options.failOn) {
        throw new Error("transport down");
      }
      const id = `ID${String(created.length)}`;
      created.push({ input, id });
      return { header: { task: { id } } } as unknown as Message;
    },
    claimTask: async (_room, taskId) => {
      if (options.refuseClaim === true) throw new Error("approval required");
      claims.push(taskId);
      return {} as Message;
    },
  };
  return { writer, created, claims };
}

describe("createPlanTasks", () => {
  it("writes the parent, claims it, then each step in dependency order with real ids", async () => {
    const { writer, created, claims } = fakeWriter();
    const result = await createPlanTasks(writer, "ops", validatePlan(GOOD), { goal: "Report" });

    assert.equal(created[0]?.input.title, "Ship the report");
    assert.match(created[0]?.input.definition ?? "", /^Report\n/);
    assert.deepEqual(claims, ["ID0"], "the planner owns the parent");
    assert.equal(result.parentClaimed, true);
    assert.deepEqual(
      result.tasks.map((t) => t.key),
      ["data", "chart", "write"],
    );

    const chart = created[2]?.input;
    assert.equal(chart?.parent, "ID0");
    assert.deepEqual(chart?.dependsOn, ["ID1"], "dependsOn is mapped from keys to created ids");
    assert.deepEqual(chart?.requires, ["python"]);
    const write = created[3]?.input;
    assert.deepEqual(write?.dependsOn, ["ID1", "ID2"]);
    assert.equal(write?.target, "machine:build-01");
    assert.equal(write?.maxAttempts, 2);
  });

  it("carries on when the parent claim is refused", async () => {
    const { writer, created } = fakeWriter({ refuseClaim: true });
    const result = await createPlanTasks(writer, "ops", validatePlan(GOOD));
    assert.equal(result.parentClaimed, false);
    assert.match(result.claimError ?? "", /approval required/);
    assert.equal(created.length, 4, "the steps are the work and are still created");
  });

  it("writes nothing when a secret is found", async () => {
    const { writer, created } = fakeWriter();
    const plan = validatePlan({
      title: "t",
      tasks: [{ key: "a", title: "A", body: "key AKIAIOSFODNN7EXAMPLE" }],
    });
    await assert.rejects(() => createPlanTasks(writer, "ops", plan), PlanError);
    assert.equal(created.length, 0, "a plan is all-or-nothing as far as secrets go");
  });

  it("reports what exists when it stops partway", async () => {
    const { writer } = fakeWriter({ failOn: "Write it up" });
    await assert.rejects(
      () => createPlanTasks(writer, "ops", validatePlan(GOOD)),
      (error: unknown) => {
        assert.ok(error instanceof PlanCreateError);
        assert.equal(error.created?.parent.id, "ID0");
        assert.deepEqual(
          error.created?.tasks.map((t) => t.key),
          ["data", "chart"],
        );
        assert.match(error.message, /transport down/);
        assert.match(error.message, /data=ID1, chart=ID2/);
        return true;
      },
    );
  });
});
