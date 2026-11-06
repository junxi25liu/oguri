import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_WORKER_POLICY, type WorkerPolicy } from "@oguri/core";

import { resolveThinker } from "../src/model.ts";

/** A worker policy with only the runners this test names. */
function worker(runners: WorkerPolicy["runners"]): WorkerPolicy {
  return { ...DEFAULT_WORKER_POLICY, enabled: true, runners };
}

describe("superagent thinker runner", () => {
  it("uses the model for a fresh call and every resumed call", () => {
    const thinker = resolveThinker(
      worker({
        brain: {
          argv: ["claude", "-p"],
          model: "my-cheap-model",
          resume: ["claude", "-p", "--resume", "{session}"],
          session: "claude-json",
          worktree: false,
        },
      }),
      "brain",
    );
    assert.deepEqual(thinker.argv, ["claude", "-p", "--model", "my-cheap-model"]);
    assert.deepEqual(thinker.resume, [
      "claude",
      "-p",
      "--resume",
      "{session}",
      "--model",
      "my-cheap-model",
    ]);
  });

  it("uses the codex flag and keeps a model the owner already chose", () => {
    const thinker = resolveThinker(
      worker({
        brain: { argv: ["codex", "exec", "-"], model: "example-codex-model", worktree: false },
        chosen: {
          argv: ["codex", "exec", "-m", "chosen-in-argv", "-"],
          model: "example-codex-model",
          worktree: false,
        },
      }),
      "brain",
    );
    assert.deepEqual(thinker.argv, ["codex", "exec", "-", "-m", "example-codex-model"]);

    const chosen = resolveThinker(
      worker({
        brain: { argv: ["codex", "exec", "-"], model: "example-codex-model", worktree: false },
        chosen: {
          argv: ["codex", "exec", "-m", "chosen-in-argv", "-"],
          model: "example-codex-model",
          worktree: false,
        },
      }),
      "chosen",
    );
    assert.deepEqual(chosen.argv, ["codex", "exec", "-m", "chosen-in-argv", "-"]);
  });

  it("adds nothing when the runner has no model or an unknown command", () => {
    const plain = resolveThinker(
      worker({ brain: { argv: ["claude", "-p"], worktree: false } }),
      "brain",
    );
    assert.deepEqual(plain.argv, ["claude", "-p"]);

    const other = resolveThinker(
      worker({
        brain: { argv: ["agent", "decide"], model: "example-codex-model", worktree: false },
      }),
      "brain",
    );
    assert.deepEqual(other.argv, ["agent", "decide"]);
  });
});
