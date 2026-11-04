import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allowedShellCommands, buildStdin } from "../src/prompt.ts";

describe("the shell commands a worker is told about", () => {
  it("reads them from --allowedTools patterns, once each", () => {
    const argv = [
      "claude",
      "-p",
      "--allowedTools",
      "Bash(pnpm:*)",
      "Bash(git:*)",
      "Read",
      "--disallowedTools",
      "Bash(git push:*)",
    ];
    assert.deepEqual(allowedShellCommands(argv), ["pnpm", "git"]);
    assert.deepEqual(allowedShellCommands(["claude", "--allowedTools", "Bash(ls:*),Bash(cat)"]), [
      "ls",
      "cat",
    ]);
    assert.deepEqual(allowedShellCommands(["claude", "-p"]), []);
  });

  it("tells the worker in its prompt, and says nothing when there are none", () => {
    const told = buildStdin({
      text: "Do it",
      resultFile: "/r.json",
      ranBefore: false,
      shell: ["git", "ls"],
    });
    assert.match(told, /the only shell commands you may run here are: git, ls\./);
    const silent = buildStdin({ text: "Do it", resultFile: "/r.json", ranBefore: false });
    assert.ok(!silent.includes("shell commands"));
  });
});
