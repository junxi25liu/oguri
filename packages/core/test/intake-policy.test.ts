import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_INTAKE_POLICY,
  intakePolicyVersion,
  redactIntakePolicy,
} from "../src/intake-policy.ts";
import { parseLocalPolicy } from "../src/policy.ts";

/** The `intake` section of the machine-local policy (ADR 0030). */

const SECTION = [
  "intake:",
  "  enabled: true",
  "  feishu:",
  "    appId: cli_a1",
  "    appSecret: APPSECRET",
  "    allowed: [ou_alice, ou_bob]",
  "    chats:",
  "      oc_team:",
  "        room: ops",
  "        target: machine:mac-mini",
  "        requires: [gpu]",
  "",
].join("\n");

describe("intake policy", () => {
  it("is off by default", () => {
    assert.equal(DEFAULT_INTAKE_POLICY.enabled, false);
    assert.equal(parseLocalPolicy("v: 1\n", "p.yaml").intake, undefined);
  });

  it("parses a Feishu chat with its room and target", () => {
    const intake = parseLocalPolicy(SECTION, "p.yaml").intake;
    assert.equal(intake?.enabled, true);
    assert.equal(intake?.maxReplyWords, 100);
    assert.deepEqual(intake?.feishu?.allowed, ["ou_alice", "ou_bob"]);
    assert.deepEqual(intake?.feishu?.chats, [
      { id: "oc_team", room: "ops", target: "machine:mac-mini", requires: ["gpu"], anyone: false },
    ]);
    assert.equal(intake?.feishu?.pollSeconds, 10);
  });

  it("refuses what it could not act on", () => {
    const bad = (text: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(text, "p.yaml"), pattern);
    bad("intake:\n  enabled: true\n", /no source is configured/);
    bad(SECTION.replace("room: ops", "room: 'Bad Room'"), /room id/);
    bad(SECTION.replace("machine:mac-mini", "'not a target!'"), /machine:<id>/);
    bad(SECTION + "    webhook: x\n", /unknown key 'intake.feishu.webhook'/);
    bad("intake:\n  feishu:\n    appId: a\n    appSecret: s\n", /listens to nothing/);
    bad(
      "intake:\n  feishu:\n    appId: a\n    appSecret: s\n    direct: true\n",
      /directRoom is required/,
    );
  });

  it("versions who may start work, not the secret", () => {
    const base = parseLocalPolicy(SECTION, "p.yaml").intake;
    assert.ok(base !== undefined);
    const version = intakePolicyVersion(base);
    assert.match(version, /^[0-9a-f]{16}$/);
    const rotated = parseLocalPolicy(SECTION.replace("APPSECRET", "OTHER"), "p.yaml").intake;
    assert.equal(intakePolicyVersion(rotated ?? base), version);
    const widened = parseLocalPolicy(
      SECTION.replace("ou_bob]", "ou_bob, ou_carol]"),
      "p.yaml",
    ).intake;
    assert.notEqual(intakePolicyVersion(widened ?? base), version);
    assert.ok(!JSON.stringify(redactIntakePolicy(base)).includes("APPSECRET"));
  });
});
