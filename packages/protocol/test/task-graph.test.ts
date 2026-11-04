import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MalformedMessageError,
  TaskTransitionError,
  assertDependenciesMet,
  assertTaskTransition,
  createMessage,
  createTask,
  parseMessage,
  parseTask,
  serializeMessage,
  taskToWire,
  type Message,
  type Task,
} from "../src/index.ts";

const TASK = "01J8XR7K9MQ4Z2N8P0VWXYZAB0";
const DEP_A = "01J8XR7K9MQ4Z2N8P0VWXYZAB1";
const DEP_B = "01J8XR7K9MQ4Z2N8P0VWXYZAB2";
const PARENT = "01J8XR7K9MQ4Z2N8P0VWXYZAB3";

function message(task: Task): Message {
  return createMessage({
    id: "01J8XR7K9MQ4Z2N8P0VWXYZAC0",
    room: "architecture",
    from: "komdosh-claude",
    authorKind: "agent",
    kind: "question",
    needs: "agent",
    mentions: ["@room"],
    ts: "2026-08-11T14:22:33.412Z",
    body: "Do the work.\n",
    task,
  });
}

/** The wire header of a task created with `over`, ready to be tampered with. */
function wire(over: Record<string, unknown>): Record<string, unknown> {
  return {
    ...taskToWire(createTask({ id: TASK, creator: "komdosh-claude", title: "Graph" })),
    ...over,
  };
}

function code(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe("task graph fields on the wire", () => {
  it("round-trips dependencies, parent, requirements and attempts", () => {
    const task = createTask({
      id: TASK,
      creator: "komdosh-claude",
      title: "Graph",
      dependsOn: [DEP_A, DEP_B],
      parent: PARENT,
      requires: ["gpu", "rust-toolchain"],
      maxAttempts: 3,
    });
    const raw = serializeMessage(message(task));
    assert.match(
      raw,
      /task_depends_on:\n {2}- 01J8XR7K9MQ4Z2N8P0VWXYZAB1\n {2}- 01J8XR7K9MQ4Z2N8P0VWXYZAB2/,
    );
    assert.match(raw, /task_parent: 01J8XR7K9MQ4Z2N8P0VWXYZAB3/);
    assert.match(raw, /task_requires:\n {2}- gpu\n {2}- rust-toolchain/);
    assert.match(raw, /task_max_attempts: 3/);
    // Zero attempts is the starting state and is not written.
    assert.doesNotMatch(raw, /task_attempt:/);
    assert.deepEqual(parseMessage(raw).header.task, task);

    const claimed: Task = {
      ...task,
      action: "claimed",
      state: "claimed",
      assignee: "alice-cursor",
      attempt: 1,
      claimantCapabilities: ["gpu", "rust-toolchain"],
    };
    const claimedRaw = serializeMessage(message(claimed));
    assert.match(claimedRaw, /task_attempt: 1/);
    assert.match(claimedRaw, /task_claimant_capabilities:/);
    assert.deepEqual(parseMessage(claimedRaw).header.task, claimed);
  });

  it("parses a task without graph fields exactly as before", () => {
    const task = createTask({ id: TASK, creator: "komdosh-claude", title: "Plain" });
    const raw = serializeMessage(message(task));
    assert.doesNotMatch(raw, /task_depends_on|task_parent|task_requires|task_max_attempts/);
    assert.deepEqual(parseMessage(raw).header.task, {
      id: TASK,
      state: "open",
      action: "created",
      creator: "komdosh-claude",
      title: "Plain",
      staleAfterSeconds: 86400,
    });
  });

  it("reads an empty list as absent, so a snapshot has one wire form", () => {
    const task = parseTask(wire({ task_depends_on: [], task_requires: [] }));
    assert.equal(task?.dependsOn, undefined);
    assert.equal(task?.requires, undefined);
  });

  it("rejects malformed graph fields", () => {
    const cases: Record<string, unknown>[] = [
      { task_depends_on: ["not-a-ulid"] },
      { task_depends_on: [DEP_A, DEP_A] },
      { task_depends_on: [TASK] },
      {
        task_depends_on: Array.from(
          { length: 33 },
          (_, i) => `01J8XR7K9MQ4Z2N8P0VWXY${String(i).padStart(4, "0")}`,
        ),
      },
      { task_depends_on: DEP_A },
      { task_parent: "nope" },
      { task_parent: TASK },
      { task_requires: ["GPU"] },
      { task_requires: ["9lives"] },
      { task_requires: ["a".repeat(33)] },
      { task_requires: ["gpu", "gpu"] },
      { task_requires: Array.from({ length: 17 }, (_, i) => `cap-${String(i)}`) },
      { task_max_attempts: 0 },
      { task_max_attempts: 21 },
      { task_max_attempts: 1.5 },
      { task_attempt: -1 },
      // Capabilities are meaningful only on a claim of a task that requires them.
      { task_claimant_capabilities: ["gpu"] },
    ];
    for (const over of cases) {
      assert.throws(
        () => parseTask(wire(over)),
        MalformedMessageError,
        `expected ${JSON.stringify(over)} to be rejected`,
      );
    }
  });

  it("rejects claimant capabilities on a claim of a task that requires none", () => {
    const claimed = {
      ...wire({}),
      task_state: "claimed",
      task_action: "claimed",
      task_assignee: "alice-cursor",
      task_claimant_capabilities: ["gpu"],
    };
    assert.throws(() => parseTask(claimed), /task_claimant_capabilities requires task_requires/);
  });
});

describe("task graph transitions", () => {
  const open = createTask({
    id: TASK,
    creator: "komdosh-claude",
    title: "Graph",
    dependsOn: [DEP_A],
    requires: ["gpu"],
    maxAttempts: 2,
  });
  const claim = (by: string, capabilities: string[] | undefined, attempt?: number): Task => ({
    ...open,
    action: "claimed",
    state: "claimed",
    assignee: by,
    ...(attempt === undefined ? {} : { attempt }),
    ...(capabilities === undefined ? {} : { claimantCapabilities: capabilities }),
  });

  it("fixes the graph at creation: a refinement may not change it", () => {
    const { dependsOn: _dropped, ...withoutDependencies } = open;
    for (const next of [
      { ...withoutDependencies, action: "refined" as const },
      { ...open, action: "refined" as const, dependsOn: [DEP_A, DEP_B] },
      { ...open, action: "refined" as const, parent: PARENT },
      { ...open, action: "refined" as const, requires: ["cpu"] },
      { ...open, action: "refined" as const, maxAttempts: 3 },
    ]) {
      assert.throws(() => assertTaskTransition(open, next, "bob-codex"), /immutable/);
    }
    assert.doesNotThrow(() =>
      assertTaskTransition(open, { ...open, action: "refined", title: "Clearer" }, "bob-codex"),
    );
  });

  it("refuses a claim that does not declare every required capability", () => {
    for (const capabilities of [undefined, ["cpu"]]) {
      let caught: unknown;
      try {
        assertTaskTransition(open, claim("alice-cursor", capabilities, 1), "alice-cursor");
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof TaskTransitionError, "expected a refusal");
      assert.equal(code(caught), "CAPABILITY_MISSING");
    }
    assert.doesNotThrow(() =>
      assertTaskTransition(open, claim("alice-cursor", ["gpu"], 1), "alice-cursor"),
    );
  });

  it("refuses a claim once attempts are used up", () => {
    const used = { ...open, attempt: 2 };
    let caught: unknown;
    try {
      assertTaskTransition(used, { ...claim("alice-cursor", ["gpu"]), attempt: 3 }, "alice-cursor");
    } catch (error) {
      caught = error;
    }
    assert.equal(code(caught), "ATTEMPTS_EXHAUSTED");
  });

  it("checks a carried attempt counter, and accepts one that is absent", () => {
    assert.throws(
      () => assertTaskTransition(open, claim("alice-cursor", ["gpu"], 2), "alice-cursor"),
      /task_attempt must be 1/,
    );
    // An older client writes no counter; the reader derives it.
    assert.doesNotThrow(() =>
      assertTaskTransition(open, claim("alice-cursor", ["gpu"]), "alice-cursor"),
    );
  });

  it("keeps the attempt counter across release and reopen", () => {
    const claimed = claim("alice-cursor", ["gpu"], 1);
    const released: Task = { ...open, action: "released", attempt: 1 };
    assert.doesNotThrow(() => assertTaskTransition(claimed, released, "alice-cursor"));
    assert.throws(
      () =>
        assertTaskTransition(claimed, { ...open, action: "released", attempt: 2 }, "alice-cursor"),
      /task_attempt must be 1/,
    );
    const reopened: Task = { ...open, action: "reopened", attempt: 1 };
    const completed: Task = { ...claimed, action: "completed", state: "completed" };
    assert.doesNotThrow(() => assertTaskTransition(completed, reopened, "komdosh-claude"));
  });

  it("names what a claim is waiting on", () => {
    let caught: unknown;
    try {
      assertDependenciesMet({ ...open, dependsOn: [DEP_A, DEP_B] }, (id) =>
        id === DEP_A ? "completed" : id === DEP_B ? "in_progress" : undefined,
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(code(caught), "DEPENDENCY_PENDING");
    assert.match(String(caught), new RegExp(`${DEP_B} \\(in_progress\\)`));
    assert.doesNotMatch(String(caught), new RegExp(DEP_A));
    assert.doesNotThrow(() => assertDependenciesMet(open, () => "completed"));
  });
});
