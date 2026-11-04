import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, describe, it } from "node:test";

import type { PushChannel } from "@oguri/core";

import { FeishuTokenCache } from "../src/feishu-app.ts";
import { type PushEvent, buildPushRequest, sendPush } from "../src/push.ts";

/**
 * Direct messages through a Feishu self-built app (ADR 0028). A loopback
 * server plays both Feishu endpoints, so the token exchange and the send are
 * asserted as Feishu would receive them.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const SEND_PATH = "/open-apis/im/v1/messages";

interface Hit {
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** A fake Feishu. Each test sets how the two endpoints answer. */
class FakeFeishu {
  hits: Hit[] = [];
  /** Tokens handed out, in order. */
  minted = 0;
  tokenReply: (n: number) => { status: number; body: unknown } = (n) => ({
    status: 200,
    body: { code: 0, msg: "ok", tenant_access_token: `t-${String(n)}`, expire: 7200 },
  });
  sendReply: (hit: Hit) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { code: 0, msg: "success", data: { message_id: "om_1" } },
  });
  /** Delay before the token endpoint answers, to make concurrent sends overlap. */
  tokenDelayMs = 0;
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (raw += chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        const hit: Hit = {
          path: url.pathname,
          query: url.searchParams,
          authorization: req.headers["authorization"],
          body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
        };
        this.hits.push(hit);
        const answer = (reply: { status: number; body: unknown }): void => {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify(reply.body));
        };
        if (hit.path === TOKEN_PATH) {
          this.minted += 1;
          const n = this.minted;
          setTimeout(() => answer(this.tokenReply(n)), this.tokenDelayMs);
        } else if (hit.path === SEND_PATH) {
          answer(this.sendReply(hit));
        } else {
          answer({ status: 404, body: { code: 404 } });
        }
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  get sends(): Hit[] {
    return this.hits.filter((hit) => hit.path === SEND_PATH);
  }

  get tokenCalls(): Hit[] {
    return this.hits.filter((hit) => hit.path === TOKEN_PATH);
  }

  reset(): void {
    this.hits = [];
    this.minted = 0;
    this.tokenDelayMs = 0;
    this.tokenReply = (n) => ({
      status: 200,
      body: { code: 0, msg: "ok", tenant_access_token: `t-${String(n)}`, expire: 7200 },
    });
    this.sendReply = () => ({ status: 200, body: { code: 0, msg: "success" } });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

const feishu = new FakeFeishu();
let base: string;

function channel(overrides: Partial<PushChannel> = {}): PushChannel {
  return {
    name: "me",
    format: "feishu-app",
    appId: "cli_test",
    appSecret: "APP-SECRET-VALUE",
    receiveIdType: "email",
    receiveId: "alice@example.com",
    apiUrl: base,
    events: ["needs-human"],
    maxPerHour: 30,
    ...overrides,
  };
}

function event(body = "Should we ship on Friday?"): PushEvent {
  return {
    reason: "needs-human",
    urgent: true,
    network: "acme",
    room: "ops",
    from: "bob-claude",
    messageId: "01J000000000000000000000AA",
    ts: "2026-11-03T08:00:00.000Z",
    task: { id: "01J000000000000000000000BB", title: "Release 2.0", state: "blocked" },
    body,
  };
}

before(async () => {
  base = await feishu.start();
});

after(async () => {
  await feishu.stop();
});

beforeEach(() => {
  feishu.reset();
});

describe("feishu-app request", () => {
  it("addresses one person and carries the text as Feishu's JSON-string content", () => {
    const request = buildPushRequest(channel(), event());
    assert.equal(request.url, `${base}/open-apis/im/v1/messages?receive_id_type=email`);
    const body = request.body as { receive_id: string; msg_type: string; content: string };
    assert.equal(body.receive_id, "alice@example.com");
    assert.equal(body.msg_type, "text");
    const text = (JSON.parse(body.content) as { text: string }).text;
    assert.match(text, /Decision needed · #ops/);
    assert.match(text, /task 01J000000000000000000000BB — Release 2\.0 \[blocked\]/);
    assert.match(text, /Should we ship on Friday\?/);
  });

  it("defaults to the Feishu API and to open_id", () => {
    const request = buildPushRequest(
      channel({ apiUrl: undefined, receiveIdType: undefined, receiveId: "ou_1" } as never),
      event(),
    );
    assert.equal(
      request.url,
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    );
  });

  it("withholds a body the secret scanner flags", () => {
    const request = buildPushRequest(channel(), event("key AKIAIOSFODNN7EXAMPLE leaked"));
    const content = (request.body as { content: string }).content;
    assert.ok(!content.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.match(content, /body withheld/);
  });
});

describe("feishu-app delivery", () => {
  it("trades the app credentials for a token, then sends with it", async () => {
    const tokens = new FeishuTokenCache();
    const result = await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.deepEqual(result, { channel: "me", ok: true });

    assert.equal(feishu.tokenCalls.length, 1);
    assert.deepEqual(feishu.tokenCalls[0]?.body, {
      app_id: "cli_test",
      app_secret: "APP-SECRET-VALUE",
    });
    assert.equal(feishu.sends.length, 1);
    assert.equal(feishu.sends[0]?.authorization, "Bearer t-1");
    assert.equal(feishu.sends[0]?.query.get("receive_id_type"), "email");
    assert.equal(feishu.sends[0]?.body["receive_id"], "alice@example.com");
  });

  it("reuses the cached token for later pushes", async () => {
    const tokens = new FeishuTokenCache();
    await sendPush(channel(), event(), { feishuTokens: tokens });
    await sendPush(channel(), event(), { feishuTokens: tokens });
    await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(feishu.tokenCalls.length, 1);
    assert.equal(feishu.sends.length, 3);
    assert.ok(feishu.sends.every((hit) => hit.authorization === "Bearer t-1"));
  });

  it("mints one token for concurrent pushes, not one each", async () => {
    const tokens = new FeishuTokenCache();
    feishu.tokenDelayMs = 50;
    const results = await Promise.all(
      [1, 2, 3, 4].map(async () => await sendPush(channel(), event(), { feishuTokens: tokens })),
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(feishu.tokenCalls.length, 1);
  });

  it("refreshes the token before it expires", async () => {
    let now = 1_000_000;
    const tokens = new FeishuTokenCache(() => now);
    feishu.tokenReply = (n) => ({
      status: 200,
      body: { code: 0, tenant_access_token: `t-${String(n)}`, expire: 600 },
    });
    await sendPush(channel(), event(), { feishuTokens: tokens });
    // 600s minus the five-minute margin: still valid at +4 minutes, stale at +6.
    now += 4 * 60_000;
    await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(feishu.tokenCalls.length, 1);
    now += 2 * 60_000;
    await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(feishu.tokenCalls.length, 2);
    assert.equal(feishu.sends.at(-1)?.authorization, "Bearer t-2");
  });

  it("mints again and retries once when Feishu calls the token invalid", async () => {
    const tokens = new FeishuTokenCache();
    feishu.sendReply = (hit) =>
      hit.authorization === "Bearer t-1"
        ? { status: 400, body: { code: 99991663, msg: "Invalid access token for authorization." } }
        : { status: 200, body: { code: 0, msg: "success" } };
    const result = await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(result.ok, true, result.error);
    assert.equal(feishu.tokenCalls.length, 2);
    assert.deepEqual(
      feishu.sends.map((hit) => hit.authorization),
      ["Bearer t-1", "Bearer t-2"],
    );
  });

  it("gives up after one retry, so a bad token never loops", async () => {
    const tokens = new FeishuTokenCache();
    feishu.sendReply = () => ({ status: 400, body: { code: 99991663, msg: "invalid" } });
    const result = await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(result.ok, false);
    assert.equal(result.error, "feishu-app send: code 99991663");
    assert.equal(feishu.sends.length, 2);
  });

  it("reports a refused secret with Feishu's code and never the secret", async () => {
    const tokens = new FeishuTokenCache();
    feishu.tokenReply = () => ({
      status: 400,
      body: { code: 10014, msg: "app secret invalid APP-SECRET-VALUE" },
    });
    const result = await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(result.ok, false);
    assert.equal(result.error, "feishu-app token: code 10014");
    assert.ok(!JSON.stringify(result).includes("APP-SECRET-VALUE"));
    assert.equal(feishu.sends.length, 0, "nothing is sent without a token");
  });

  it("does not cache a failed token request", async () => {
    const tokens = new FeishuTokenCache();
    feishu.tokenReply = (n) =>
      n === 1
        ? { status: 500, body: {} }
        : { status: 200, body: { code: 0, tenant_access_token: "t-ok", expire: 7200 } };
    assert.equal((await sendPush(channel(), event(), { feishuTokens: tokens })).ok, false);
    assert.equal((await sendPush(channel(), event(), { feishuTokens: tokens })).ok, true);
    assert.equal(feishu.sends.at(-1)?.authorization, "Bearer t-ok");
  });

  it("treats a send refusal as a failure, even on HTTP 200", async () => {
    const tokens = new FeishuTokenCache();
    // 230013: the person is outside the app's availability range.
    feishu.sendReply = () => ({ status: 200, body: { code: 230013, msg: "no availability" } });
    const result = await sendPush(channel(), event(), { feishuTokens: tokens });
    assert.equal(result.ok, false);
    assert.equal(result.error, "feishu-app send: code 230013");
  });

  it("keeps a separate token per app, and drops it when the secret changes", async () => {
    const tokens = new FeishuTokenCache();
    await sendPush(channel(), event(), { feishuTokens: tokens });
    await sendPush(channel({ appId: "cli_other" }), event(), { feishuTokens: tokens });
    await sendPush(channel({ appSecret: "ROTATED" }), event(), { feishuTokens: tokens });
    assert.equal(feishu.tokenCalls.length, 3);
  });

  it("reports an unreachable API without throwing", async () => {
    const result = await sendPush(channel({ apiUrl: "http://127.0.0.1:9" }), event(), {
      feishuTokens: new FeishuTokenCache(),
      timeoutMs: 2_000,
    });
    assert.equal(result.ok, false);
    assert.ok(result.error !== undefined && result.error.length > 0);
    assert.ok(!result.error.includes("APP-SECRET-VALUE"));
  });
});

describe("oguri notify test with a feishu-app channel", () => {
  let tmp: string;
  let home: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oguri-feishu-app-"));
    home = join(tmp, "home");
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    await exec(
      process.execPath,
      [CLI, "init", "--repo", remote, "--network", "acme", "--agent", "alice-claude", "--direct"],
      { env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1" } },
    );
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("sends a direct message and lists the channel without its secret", async () => {
    await writeFile(
      join(home, "policy.yaml"),
      [
        "notifications:",
        "  channels:",
        "    me:",
        "      format: feishu-app",
        "      appId: cli_test",
        "      appSecret: APP-SECRET-VALUE",
        "      receiveId: alice@example.com",
        `      apiUrl: ${base}`,
        "",
      ].join("\n"),
    );
    const env = { ...process.env, OGURI_HOME: home, NO_COLOR: "1" };

    const listed = await exec(process.execPath, [CLI, "notify", "--direct"], { env });
    assert.match(listed.stdout, /feishu-app → 127\.0\.0\.1:\d+, email alice@example\.com/);
    assert.ok(!listed.stdout.includes("APP-SECRET-VALUE"));

    const sent = await exec(
      process.execPath,
      [CLI, "notify", "test", "--channel", "me", "--direct"],
      {
        env,
      },
    );
    assert.ok(!(sent.stdout + sent.stderr).includes("APP-SECRET-VALUE"));
    assert.equal(feishu.sends.length, 1, sent.stdout + sent.stderr);
    const content = JSON.parse(String(feishu.sends[0]?.body["content"])) as { text: string };
    assert.match(content.text, /Test notification/);

    const policy = await exec(process.execPath, [CLI, "policy", "--json", "--direct"], { env });
    assert.ok(!policy.stdout.includes("APP-SECRET-VALUE"), "policy --json redacts the secret");
  });
});
