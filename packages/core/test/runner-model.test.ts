import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withRunnerModel } from "../src/runner-model.ts";

describe("runner model argv", () => {
  it("adds the claude and codex flags at the end of the owner's argv", () => {
    assert.deepEqual(withRunnerModel(["claude", "-p"], "deepseek-v4.1-flash"), [
      "claude",
      "-p",
      "--model",
      "deepseek-v4.1-flash",
    ]);
    assert.deepEqual(withRunnerModel(["codex", "exec", "-"], "gpt-5-codex"), [
      "codex",
      "exec",
      "-",
      "-m",
      "gpt-5-codex",
    ]);
    assert.deepEqual(withRunnerModel(["/opt/bin/Claude.exe", "-p"], "gpt-5-codex"), [
      "/opt/bin/Claude.exe",
      "-p",
      "--model",
      "gpt-5-codex",
    ]);
  });

  it("leaves an argv alone when no model is named or its command is unknown", () => {
    assert.deepEqual(withRunnerModel(["claude", "-p"], undefined), ["claude", "-p"]);
    assert.deepEqual(withRunnerModel(["agent", "run"], "gpt-5-codex"), ["agent", "run"]);
    assert.deepEqual(withRunnerModel([], "gpt-5-codex"), []);
  });

  it("never adds a second model flag to an argv or a resume argv", () => {
    const claude = ["claude", "-p", "--model", "already-chosen"];
    const claudeEquals = ["claude", "-p", "--model=already-chosen"];
    const codex = ["codex", "exec", "-m", "already-chosen", "-"];
    const codexEquals = ["codex", "exec", "-m=already-chosen", "-"];
    const codexAttached = ["codex", "exec", "-malready-chosen", "-"];
    for (const argv of [claude, claudeEquals, codex, codexEquals, codexAttached]) {
      assert.deepEqual(withRunnerModel(argv, "gpt-5-codex"), argv);
    }
    const resume = ["claude", "-p", "--resume", "{session}"];
    assert.deepEqual(withRunnerModel(resume, "gpt-5-codex"), [
      "claude",
      "-p",
      "--resume",
      "{session}",
      "--model",
      "gpt-5-codex",
    ]);
  });

  it("does not mistake another argument for a model flag", () => {
    assert.deepEqual(withRunnerModel(["codex", "exec", "--model-info", "-"], "gpt-5-codex"), [
      "codex",
      "exec",
      "--model-info",
      "-",
      "-m",
      "gpt-5-codex",
    ]);
  });
});
