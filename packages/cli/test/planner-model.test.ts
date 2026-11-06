import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_WORKER_POLICY, type WorkerPolicy } from "@oguri/core";

import { resolvePlannerRunner } from "../src/planner.ts";

function worker(runners: WorkerPolicy["runners"]): WorkerPolicy {
  return { ...DEFAULT_WORKER_POLICY, enabled: false, runners };
}

describe("planner runner model", () => {
  it("uses a runner's model for oguri plan too", () => {
    const runner = resolvePlannerRunner(
      worker({ brain: { argv: ["claude", "-p"], model: "example-codex-model", worktree: false } }),
      "brain",
    );
    assert.deepEqual(runner.argv, ["claude", "-p", "--model", "example-codex-model"]);
  });

  it("keeps a model already in the planner's argv", () => {
    const runner = resolvePlannerRunner(
      worker({
        brain: {
          argv: ["codex", "exec", "-c", "model=chosen-in-argv", "-"],
          model: "example-codex-model",
          worktree: false,
        },
      }),
      "brain",
    );
    assert.deepEqual(runner.argv, ["codex", "exec", "-c", "model=chosen-in-argv", "-"]);
  });
});
