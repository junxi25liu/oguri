import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_INTAKE_POLICY, intakePolicyVersion, type IntakePolicy } from "@oguri/core";

import { IGNORE_REASONS, admit } from "../src/admission.ts";
import type { InboundMessage } from "../src/source.ts";
import type { TaskLink } from "../src/state.ts";

/** Who may start work, and what a chat message is (ADR 0030 §2, §4). Pure, so a matrix. */

function policy(feishu: Partial<NonNullable<IntakePolicy["feishu"]>> = {}): IntakePolicy {
  return {
    ...DEFAULT_INTAKE_POLICY,
    enabled: true,
    feishu: {
      appId: "cli_test",
      appSecret: "s",
      pollSeconds: 10,
      allowed: ["ou_alice"],
      direct: false,
      chats: [
        { id: "oc_team", room: "ops", target: "machine:build", requires: ["gpu"], anyone: false },
        { id: "oc_open", room: "open", anyone: true },
        { id: "oc_dm", room: "dm", anyone: false },
      ],
      ...feishu,
    },
  };
}

function message(overrides: {
  actor?: string;
  human?: boolean;
  chat?: string;
  addressed?: InboundMessage["addressed"];
  text?: string;
}): InboundMessage {
  return {
    external: {
      source: "feishu",
      id: "om_1",
      conversation: overrides.chat ?? "oc_team",
      actor: overrides.actor ?? "ou_alice",
      human: overrides.human ?? true,
    },
    text: overrides.text ?? "fix the cancel button",
    addressed: overrides.addressed === undefined ? "mention" : overrides.addressed,
    at: new Date().toISOString(),
  };
}

const LINK: TaskLink = { network: "acme", room: "ops", taskId: "T1", threadRoot: "R1" };

describe("admit", () => {
  it("admits an allowed person's mention in a configured chat, with the chat's routing", () => {
    const p = policy();
    assert.deepEqual(admit(p, message({}), undefined), {
      kind: "request",
      room: "ops",
      target: "machine:build",
      requires: ["gpu"],
      mandate: { strength: "explicit", via: "addressed", policy: intakePolicyVersion(p) },
    });
  });

  it("admits anyone who mentions the bot in a chat with anyone: true", () => {
    const decision = admit(policy(), message({ chat: "oc_open", actor: "ou_stranger" }), undefined);
    assert.equal(decision.kind, "request");
    assert.equal(decision.kind === "request" ? decision.room : "", "open");
    assert.equal(decision.kind === "request" ? decision.target : "x", undefined);
  });

  const ignored: [string, IntakePolicy, InboundMessage, string][] = [
    [
      "a stranger in a closed chat",
      policy(),
      message({ actor: "ou_stranger" }),
      IGNORE_REASONS.notAllowed,
    ],
    ["a bot, even an allowed id", policy(), message({ human: false }), IGNORE_REASONS.notHuman],
    [
      "a bot in an open chat",
      policy(),
      message({ chat: "oc_open", human: false }),
      IGNORE_REASONS.notHuman,
    ],
    [
      "a message that does not address the bot",
      policy(),
      message({ addressed: null }),
      IGNORE_REASONS.notAddressed,
    ],
    [
      "a chat nobody configured",
      policy(),
      message({ chat: "oc_other" }),
      IGNORE_REASONS.unknownChat,
    ],
    ["a bare mention with no request", policy(), message({ text: "  " }), IGNORE_REASONS.empty],
    [
      "a direct message while direct is off",
      policy(),
      message({ chat: "oc_dm", addressed: "direct" }),
      IGNORE_REASONS.directOff,
    ],
    [
      "a direct message from a stranger",
      policy({ direct: true, directRoom: "dms" }),
      message({ chat: "oc_dm", addressed: "direct", actor: "ou_stranger" }),
      IGNORE_REASONS.notAllowed,
    ],
    [
      "any message when no source is configured",
      { ...DEFAULT_INTAKE_POLICY, enabled: true },
      message({}),
      IGNORE_REASONS.noSource,
    ],
  ];
  for (const [name, p, m, reason] of ignored) {
    it(`ignores ${name}`, () => {
      assert.deepEqual(admit(p, m, undefined), { kind: "ignore", reason });
    });
  }

  it("admits a direct message from an allowed person when direct is on", () => {
    const p = policy({ direct: true, directRoom: "dms", directTarget: "bob-claude" });
    const listed = admit(p, message({ chat: "oc_dm", addressed: "direct" }), undefined);
    // A listed chat's room wins; directTarget fills in the missing target.
    assert.equal(listed.kind === "request" ? listed.room : "", "dm");
    assert.equal(listed.kind === "request" ? listed.target : "", "bob-claude");
    const unlisted = admit(p, message({ chat: "oc_new", addressed: "direct" }), undefined);
    assert.equal(unlisted.kind === "request" ? unlisted.room : "", "dms");
    assert.equal(unlisted.kind === "request" ? unlisted.target : "", "bob-claude");
  });

  it("treats a message in a known task thread as a follow-up, addressed or not", () => {
    assert.deepEqual(admit(policy(), message({ addressed: null }), LINK), {
      kind: "followup",
      taskRef: LINK,
      admitted: true,
    });
  });

  it("relays a stranger's follow-up as context that may not resume the task", () => {
    assert.deepEqual(admit(policy(), message({ actor: "ou_stranger", addressed: null }), LINK), {
      kind: "followup",
      taskRef: LINK,
      admitted: false,
    });
    const open = admit(
      policy(),
      message({ chat: "oc_open", actor: "ou_x", addressed: null }),
      LINK,
    );
    assert.equal(open.kind === "followup" && open.admitted, true);
  });

  it("never relays a bot's message, even in a task thread", () => {
    assert.equal(admit(policy(), message({ human: false }), LINK).kind, "ignore");
  });

  it("records a mandate that changes with who may start work", () => {
    const a = admit(policy(), message({}), undefined);
    const b = admit(policy({ allowed: ["ou_alice", "ou_bob"] }), message({}), undefined);
    assert.ok(a.kind === "request" && b.kind === "request");
    assert.notEqual(a.mandate.policy, b.mandate.policy);
  });
});
