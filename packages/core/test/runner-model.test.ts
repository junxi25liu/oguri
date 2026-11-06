import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { effortConflict, withRunnerEffort, withRunnerModel } from "../src/runner-model.ts";

describe("runner model argv", () => {
  it("adds the claude and codex flags at the end of the owner's argv", () => {
    assert.deepEqual(withRunnerModel(["claude", "-p"], "my-cheap-model"), [
      "claude",
      "-p",
      "--model",
      "my-cheap-model",
    ]);
    assert.deepEqual(withRunnerModel(["codex", "exec", "-"], "example-codex-model"), [
      "codex",
      "exec",
      "-",
      "-m",
      "example-codex-model",
    ]);
    assert.deepEqual(withRunnerModel(["/opt/bin/Claude.exe", "-p"], "example-codex-model"), [
      "/opt/bin/Claude.exe",
      "-p",
      "--model",
      "example-codex-model",
    ]);
  });

  it("leaves an argv alone when no model is named or its command is unknown", () => {
    assert.deepEqual(withRunnerModel(["claude", "-p"], undefined), ["claude", "-p"]);
    assert.deepEqual(withRunnerModel(["agent", "run"], "example-codex-model"), ["agent", "run"]);
    assert.deepEqual(withRunnerModel([], "example-codex-model"), []);
  });

  it("never adds a second model flag to an argv or a resume argv", () => {
    const claude = ["claude", "-p", "--model", "already-chosen"];
    const claudeEquals = ["claude", "-p", "--model=already-chosen"];
    const codex = ["codex", "exec", "-m", "already-chosen", "-"];
    const codexEquals = ["codex", "exec", "-m=already-chosen", "-"];
    const codexAttached = ["codex", "exec", "-malready-chosen", "-"];
    for (const argv of [claude, claudeEquals, codex, codexEquals, codexAttached]) {
      assert.deepEqual(withRunnerModel(argv, "example-codex-model"), argv);
    }
    const resume = ["claude", "-p", "--resume", "{session}"];
    assert.deepEqual(withRunnerModel(resume, "example-codex-model"), [
      "claude",
      "-p",
      "--resume",
      "{session}",
      "--model",
      "example-codex-model",
    ]);
  });

  it("does not mistake another argument for a model flag", () => {
    assert.deepEqual(
      withRunnerModel(["codex", "exec", "--model-info", "-"], "example-codex-model"),
      ["codex", "exec", "--model-info", "-", "-m", "example-codex-model"],
    );
  });
});

describe("runner effort argv", () => {
  it("adds --effort to a claude argv, last, and never twice", () => {
    assert.deepEqual(withRunnerEffort(["claude", "-p"], "high"), [
      "claude",
      "-p",
      "--effort",
      "high",
    ]);
    assert.deepEqual(withRunnerEffort(["/opt/bin/Claude.exe", "-p"], "low"), [
      "/opt/bin/Claude.exe",
      "-p",
      "--effort",
      "low",
    ]);
    const already = ["claude", "-p", "--effort", "high"];
    const equals = ["claude", "-p", "--effort=high"];
    for (const argv of [already, equals]) assert.deepEqual(withRunnerEffort(argv, "low"), argv);
  });

  it("leaves an argv alone when no effort is named or its command has no effort flag", () => {
    assert.deepEqual(withRunnerEffort(["claude", "-p"], undefined), ["claude", "-p"]);
    // Only claude is known to understand --effort. The policy parser refuses
    // the key for anything else, so this is the second line of defence.
    assert.deepEqual(withRunnerEffort(["codex", "exec", "-"], "high"), ["codex", "exec", "-"]);
    assert.deepEqual(withRunnerEffort(["agent", "run"], "high"), ["agent", "run"]);
    assert.deepEqual(withRunnerEffort([], "high"), []);
  });

  it("does not mistake another argument for the effort flag", () => {
    assert.deepEqual(withRunnerEffort(["claude", "-p", "--effort-max", "x"], "high"), [
      "claude",
      "-p",
      "--effort-max",
      "x",
      "--effort",
      "high",
    ]);
  });

  it("reports a conflict when the argv already chose a different level", () => {
    // Gap 1: `--effort high` in the argv plus a request for `max` used to keep
    // `high` and say nothing. The owner's argv still wins, but the caller must
    // be able to say why the request was not honoured.
    assert.deepEqual(withRunnerEffort(["claude", "-p", "--effort", "high"], "max"), [
      "claude",
      "-p",
      "--effort",
      "high",
    ]);
    const conflict = effortConflict(["claude", "-p", "--effort", "high"], "max");
    assert.match(conflict ?? "", /--effort high/);
    assert.match(conflict ?? "", /max/);

    assert.match(effortConflict(["claude", "-p", "--effort=high"], "max") ?? "", /--effort=high/);

    // The same level asked twice is not a conflict.
    assert.equal(effortConflict(["claude", "-p", "--effort", "max"], "max"), undefined);
    assert.equal(effortConflict(["claude", "-p", "--effort=max"], "max"), undefined);
    // Nothing asked, or nothing already chosen: no conflict either way.
    assert.equal(effortConflict(["claude", "-p", "--effort", "high"], undefined), undefined);
    assert.equal(effortConflict(["claude", "-p"], "max"), undefined);
    // A command with no effort flag never conflicts.
    assert.equal(effortConflict(["codex", "exec", "--effort", "high", "-"], "max"), undefined);
  });
});
