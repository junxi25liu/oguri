import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * The helper exists because a parent process that exports `OGURI_AGENT` made
 * every `init --agent <other-id>` in this suite fail with exit 6. The bug was
 * invisible on a clean shell, so the assertion has to be about the parent's
 * variables, not just about the value a caller passes.
 */
describe("testEnv", () => {
  it("drops an inherited OGURI_HOME and OGURI_AGENT", () => {
    const before = {
      home: process.env["OGURI_HOME"],
      agent: process.env["OGURI_AGENT"],
    };
    process.env["OGURI_HOME"] = "/parents/home";
    process.env["OGURI_AGENT"] = "parents-agent";
    try {
      const env = testEnv({ NO_COLOR: "1" });
      assert.equal(env["OGURI_HOME"], undefined);
      assert.equal(env["OGURI_AGENT"], undefined);
      assert.equal(env["NO_COLOR"], "1");
    } finally {
      for (const [key, value] of [
        ["OGURI_HOME", before.home],
        ["OGURI_AGENT", before.agent],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("still lets a test name either one deliberately", () => {
    const env = testEnv({ OGURI_HOME: "/tmp/test-home", OGURI_AGENT: "test-agent" });
    assert.equal(env["OGURI_HOME"], "/tmp/test-home");
    assert.equal(env["OGURI_AGENT"], "test-agent");
  });

  it("leaves the rest of the parent environment alone", () => {
    const env = testEnv();
    assert.equal(env["PATH"], process.env["PATH"]);
  });
});
