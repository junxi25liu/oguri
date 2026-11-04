import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Layout } from "../src/layout.ts";
import {
  DEFAULT_PUSH_PER_HOUR,
  describePushTarget,
  redactNotificationPolicy,
} from "../src/notification-policy.ts";
import {
  DEFAULT_LOCAL_POLICY,
  loadLocalPolicy,
  parseLocalPolicy,
  policyTemplate,
} from "../src/policy.ts";

/** The `notifications` section of the machine-local policy (ADR 0028). */
describe("notification policy", () => {
  it("has no channels by default, and the template parses to none", () => {
    assert.deepEqual(DEFAULT_LOCAL_POLICY.notifications.channels, []);
    assert.deepEqual(parseLocalPolicy(policyTemplate(), "template").notifications?.channels, []);
  });

  it("parses every format, with the documented defaults", () => {
    const parsed = parseLocalPolicy(
      [
        "notifications:",
        "  channels:",
        "    hook:",
        "      format: json",
        "      url: https://example.com/hook",
        "    team:",
        "      format: wecom",
        "      url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k",
        "      events: [needs-human, all, all]",
        "      maxPerHour: 5",
        "    lark:",
        "      format: feishu",
        "      url: https://open.feishu.cn/open-apis/bot/v2/hook/x",
        "      secret: s",
        "    phone:",
        "      format: telegram",
        "      token: '1:abc'",
        "      chatId: -100123",
        "",
      ].join("\n"),
      "p.yaml",
    );
    const channels = parsed.notifications?.channels ?? [];
    assert.deepEqual(
      channels.map((c) => c.name),
      ["hook", "team", "lark", "phone"],
    );
    assert.deepEqual(channels[0]?.events, ["needs-human", "task-completed", "task-blocked"]);
    assert.equal(channels[0]?.maxPerHour, DEFAULT_PUSH_PER_HOUR);
    assert.deepEqual(channels[1]?.events, ["needs-human", "all"], "duplicates collapse");
    assert.equal(channels[1]?.maxPerHour, 5);
    assert.equal(channels[2]?.secret, "s");
    assert.equal(channels[3]?.chatId, "-100123", "a numeric chat id is kept as a string");
  });

  it("refuses a channel it could not send as written", () => {
    const bad = (body: string, pattern: RegExp) =>
      assert.throws(() => parseLocalPolicy(`notifications:\n${body}`, "p.yaml"), pattern);
    bad("  channels:\n    x:\n      format: slack\n      url: https://e.com\n", /format must be/);
    bad("  channels:\n    x:\n      format: json\n", /url must be a URL/);
    bad("  channels:\n    x:\n      format: json\n      url: ftp://e.com\n", /http or https/);
    bad("  channels:\n    x:\n      format: telegram\n      token: t\n", /chatId/);
    bad(
      "  channels:\n    x:\n      format: wecom\n      url: https://e.com\n      token: t\n",
      /token does not apply to format wecom; it takes: url/,
    );
    bad(
      "  channels:\n    x:\n      format: json\n      url: https://e.com\n      secret: s\n",
      /secret does not apply to format json/,
    );
    bad(
      "  channels:\n    x:\n      format: json\n      url: https://e.com\n      events: [everything]\n",
      /unknown event "everything"/,
    );
    bad(
      "  channels:\n    x:\n      format: json\n      url: https://e.com\n      maxPerHour: 0\n",
      /maxPerHour/,
    );
    bad(
      "  channels:\n    Bad_Name:\n      format: json\n      url: https://e.com\n",
      /channel name/,
    );
    bad(
      "  channels:\n    x:\n      format: json\n      url: https://e.com\n      to: me\n",
      /unknown key/,
    );
    bad("  sinks: {}\n", /unknown key 'notifications.sinks'/);
  });

  it("parses a feishu-app channel that messages one person", () => {
    const parsed = parseLocalPolicy(
      [
        "notifications:",
        "  channels:",
        "    me:",
        "      format: feishu-app",
        "      appId: cli_a1b2",
        "      appSecret: APPSECRET",
        "      receiveId: alice@example.com",
        "    lark:",
        "      format: feishu-app",
        "      appId: cli_c3",
        "      appSecret: s",
        "      receiveIdType: open_id",
        "      receiveId: ou_123",
        "      apiUrl: https://open.larksuite.com",
        "    bare:",
        "      format: feishu-app",
        "      appId: cli_d4",
        "      appSecret: s",
        "      receiveId: ou_456",
        "",
      ].join("\n"),
      "p.yaml",
    );
    const [me, lark, bare] = parsed.notifications?.channels ?? [];
    assert.equal(me?.receiveIdType, "email", "an address is read as an email");
    assert.equal(me?.appSecret, "APPSECRET");
    assert.equal(me?.url, undefined);
    assert.equal(lark?.receiveIdType, "open_id");
    assert.equal(lark?.apiUrl, "https://open.larksuite.com");
    assert.equal(bare?.receiveIdType, "open_id", "Feishu's own default otherwise");
    assert.deepEqual(me?.events, ["needs-human", "task-completed", "task-blocked"]);

    assert.equal(
      describePushTarget(me as never),
      "feishu-app → open.feishu.cn, email alice@example.com",
    );
    assert.equal(
      describePushTarget(lark as never),
      "feishu-app → open.larksuite.com, open_id ou_123",
    );
    const printed = JSON.stringify(
      redactNotificationPolicy(parsed.notifications ?? { channels: [] }),
    );
    assert.ok(!printed.includes("APPSECRET"), "the app secret is never printed");
  });

  it("refuses a feishu-app channel it could not send", () => {
    const bad = (lines: string[], pattern: RegExp) =>
      assert.throws(
        () =>
          parseLocalPolicy(
            [
              "notifications:",
              "  channels:",
              "    me:",
              "      format: feishu-app",
              ...lines,
              "",
            ].join("\n"),
            "p.yaml",
          ),
        pattern,
      );
    bad(["      appSecret: s", "      receiveId: a@b.c"], /appId must be a non-empty string/);
    bad(["      appId: cli_x", "      receiveId: a@b.c"], /appSecret must be a non-empty string/);
    bad(["      appId: cli_x", "      appSecret: s"], /receiveId must be a non-empty string/);
    bad(
      [
        "      appId: cli_x",
        "      appSecret: s",
        "      receiveId: a",
        "      receiveIdType: phone",
      ],
      /receiveIdType must be one of: open_id, user_id, union_id, email, chat_id/,
    );
    bad(
      [
        "      appId: cli_x",
        "      appSecret: s",
        "      receiveId: a",
        "      url: https://e.com",
      ],
      /url does not apply to format feishu-app/,
    );
    bad(
      ["      appId: cli_x", "      appSecret: s", "      receiveId: a", "      apiUrl: nope"],
      /apiUrl is not a valid URL/,
    );
  });

  it("never echoes a malformed URL, which usually carries the key", () => {
    assert.throws(
      () =>
        parseLocalPolicy(
          "notifications:\n  channels:\n    x:\n      format: json\n      url: 'not a url KEY123'\n",
          "p.yaml",
        ),
      (error: Error) => !error.message.includes("KEY123"),
    );
  });

  it("describes and redacts a channel without its credentials", () => {
    const parsed = parseLocalPolicy(
      "notifications:\n  channels:\n    t:\n      format: wecom\n      url: https://q.example/send?key=SECRETKEY\n    p:\n      format: telegram\n      token: TOKEN\n      chatId: 1\n",
      "p.yaml",
    );
    const policy = parsed.notifications ?? { channels: [] };
    assert.equal(describePushTarget(policy.channels[0] as never), "wecom → q.example");
    const printed = JSON.stringify(redactNotificationPolicy(policy));
    assert.ok(!printed.includes("SECRETKEY"));
    assert.ok(!printed.includes("TOKEN"));
  });

  it("lets the nearest file that names notifications decide them whole", async () => {
    const root = await mkdtemp(join(tmpdir(), "oguri-notify-policy-"));
    try {
      const agentHome = join(root, "agents", "bob-codex");
      await mkdir(agentHome, { recursive: true });
      await writeFile(
        join(root, "policy.yaml"),
        "notifications:\n  channels:\n    machine:\n      format: json\n      url: https://e.com/m\n",
        "utf8",
      );
      const inherited = await loadLocalPolicy(new Layout(agentHome));
      assert.deepEqual(
        inherited.policy.notifications.channels.map((c) => c.name),
        ["machine"],
      );
      await writeFile(
        join(agentHome, "policy.yaml"),
        "notifications:\n  channels:\n    own:\n      format: json\n      url: https://e.com/o\n",
        "utf8",
      );
      const own = await loadLocalPolicy(new Layout(agentHome));
      assert.deepEqual(
        own.policy.notifications.channels.map((c) => c.name),
        ["own"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
