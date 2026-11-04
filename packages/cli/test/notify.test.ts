import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { testEnv } from "./env.ts";

/**
 * `oguri notify` through the built binary, against a local HTTP server
 * standing in for WeCom and Telegram (ADR 0028).
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "bin.js");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

let tmp: string;
let home: string;
let server: Server;
let base: string;
const received: { path: string; body: Record<string, unknown> }[] = [];

async function oguri(...args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: testEnv({ OGURI_HOME: home, NO_COLOR: "1" }),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-notify-"));
  home = join(tmp, "home");
  await mkdir(home, { recursive: true });
  server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.includes("/bot") === true ? '{"ok":true}' : '{"errcode":0}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("oguri notify", () => {
  it("says how to configure channels when there are none", async () => {
    const listed = await oguri("notify");
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /no push channels configured/);
    const tested = await oguri("notify", "test");
    assert.equal(tested.code, 1);
  });

  it("lists channels without printing their keys or tokens", async () => {
    await writeFile(
      join(home, "policy.yaml"),
      [
        "notifications:",
        "  channels:",
        "    team:",
        "      format: wecom",
        `      url: ${base}/cgi-bin/webhook/send?key=WECOMKEY123`,
        "      events: [needs-human, task-blocked]",
        "    phone:",
        "      format: telegram",
        '      token: "999:TGTOKENSECRET"',
        "      chatId: 42",
        `      apiUrl: ${base}`,
        "intake:",
        "  feishu:",
        "    appId: cli_intake",
        "    appSecret: INTAKESECRET42",
        "    allowed: [ou_alice]",
        "    chats:",
        "      oc_team: { room: ops }",
        "",
      ].join("\n"),
      "utf8",
    );
    const listed = await oguri("notify", "list");
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /team/);
    assert.match(listed.stdout, /phone/);
    for (const output of [listed.stdout, (await oguri("notify", "--json")).stdout]) {
      assert.ok(!output.includes("WECOMKEY123"), "the WeCom key was printed");
      assert.ok(!output.includes("TGTOKENSECRET"), "the Telegram token was printed");
    }
    const policy = await oguri("policy", "--json");
    assert.equal(policy.code, 0, policy.stderr);
    assert.ok(!policy.stdout.includes("WECOMKEY123"), "policy --json printed the WeCom key");
    assert.ok(!policy.stdout.includes("TGTOKENSECRET"), "policy --json printed the token");
    assert.ok(!policy.stdout.includes("INTAKESECRET42"), "policy --json printed the intake secret");
    const text = await oguri("policy");
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /oc_team → ops/);
    assert.ok(!text.stdout.includes("INTAKESECRET42"), "policy printed the intake secret");
  });

  it("sends a test push to one channel", async () => {
    received.length = 0;
    const result = await oguri("notify", "test", "--channel", "team");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /✓ team/);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.body["msgtype"], "markdown");
  });

  it("sends to every channel when none is named, each in its own format", async () => {
    received.length = 0;
    const result = await oguri("notify", "test");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const telegram = received.find((r) => r.path.startsWith("/bot"));
    assert.equal(telegram?.path, "/bot999:TGTOKENSECRET/sendMessage");
    assert.equal(telegram?.body["chat_id"], "42");
    assert.ok(received.some((r) => r.body["msgtype"] === "markdown"));
  });

  it("fails, without the key, when the endpoint is unreachable", async () => {
    await writeFile(
      join(home, "policy.yaml"),
      "notifications:\n  channels:\n    dead:\n      format: feishu\n      url: http://127.0.0.1:1/hook/FEISHUKEY\n",
      "utf8",
    );
    const result = await oguri("notify", "test");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /✗ dead/);
    assert.ok(!result.stdout.includes("FEISHUKEY"));
  });

  it("refuses an unknown channel name", async () => {
    const result = await oguri("notify", "test", "--channel", "nope");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no push channel named 'nope'; configured: dead/);
  });
});
