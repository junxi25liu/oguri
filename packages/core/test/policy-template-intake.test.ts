import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseLocalPolicy, policyTemplate } from "../src/policy.ts";

/**
 * The `intake:` example in the shipped template (ADR 0030) is commented out,
 * so intake stays off. Uncommented, it must be a policy the parser accepts:
 * a person who copies the example should get a working section, not an error.
 */
describe("policy template intake example", () => {
  it("leaves intake off as shipped", () => {
    assert.equal(parseLocalPolicy(policyTemplate(), "template").intake, undefined);
  });

  it("parses once uncommented", () => {
    const template = policyTemplate();
    const start = template.indexOf("# intake:");
    assert.ok(start > 0, "the template carries an intake example");
    const uncommented = template
      .slice(start)
      .split("\n")
      .map((line) => line.replace(/^# ?/, ""))
      .join("\n");
    const intake = parseLocalPolicy(template.slice(0, start) + uncommented, "example").intake;
    assert.equal(intake?.enabled, true);
    assert.deepEqual(intake?.feishu?.allowed, ["ou_0123456789abcdef"]);
    assert.deepEqual(intake?.feishu?.chats, [
      { id: "oc_0123456789abcdef", room: "app", anyone: false, target: "machine:build-box" },
    ]);
  });
});
