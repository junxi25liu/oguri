import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TaskStatus } from "@oguri/core";

import { MAX_PARENT_HOPS, isDescendant, runOf, taskDepth } from "../src/backend/run-scope.ts";

/**
 * The parent walk behind a run's depth limit (ADR 0036). Pure, so the cases a
 * real room rarely reaches — a missing parent, a chain past the cap, a cycle —
 * are checked here; the MCP suite drives the gate itself through a real run.
 */

function chain(length: number): TaskStatus[] {
  return Array.from(
    { length },
    (_, index) =>
      ({
        task: {
          id: `T${String(index)}`,
          ...(index === 0 ? {} : { parent: `T${String(index - 1)}` }),
        },
      }) as unknown as TaskStatus,
  );
}

describe("run scope: the parent walk", () => {
  it("counts parents up to the root", () => {
    const tasks = chain(3);
    assert.equal(taskDepth(tasks, "T0"), 0);
    assert.equal(taskDepth(tasks, "T2"), 2);
    assert.equal(isDescendant(tasks, "T2", "T0"), true);
    assert.equal(isDescendant(tasks, "T0", "T2"), false);
    assert.equal(isDescendant(tasks, "T1", "T1"), false, "a task is not its own subtask");
  });

  it(`stops after ${String(MAX_PARENT_HOPS)} parents and reports the depth as unknown`, () => {
    const tasks = chain(MAX_PARENT_HOPS + 2);
    assert.equal(taskDepth(tasks, `T${String(MAX_PARENT_HOPS)}`), MAX_PARENT_HOPS);
    assert.equal(taskDepth(tasks, `T${String(MAX_PARENT_HOPS + 1)}`), null);
    assert.equal(isDescendant(tasks, `T${String(MAX_PARENT_HOPS + 1)}`, "T0"), false);
  });

  it("treats a parent the room does not carry, or a cycle, as unknown rather than shallow", () => {
    const orphan = [{ task: { id: "A", parent: "GONE" } }] as unknown as TaskStatus[];
    assert.equal(taskDepth(orphan, "A"), null);
    assert.equal(taskDepth(orphan, "NOPE"), null);
    const loop = [
      { task: { id: "A", parent: "B" } },
      { task: { id: "B", parent: "A" } },
    ] as unknown as TaskStatus[];
    assert.equal(taskDepth(loop, "A"), null);
  });

  it("is a run only when the worker said so", () => {
    assert.equal(runOf({}), null);
    assert.equal(runOf({ OGURI_TASK_ID: "" }), null);
    assert.deepEqual(runOf({ OGURI_TASK_ID: "T1", OGURI_TASK_ROOM: "ops" }), {
      taskId: "T1",
      room: "ops",
    });
  });
});
