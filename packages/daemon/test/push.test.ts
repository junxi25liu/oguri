import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { Layout, type PushChannel } from "@oguri/core";
import type { Message, MessageHeader, Task } from "@oguri/protocol";

import { DaemonClient } from "../src/client.ts";
import { Daemon } from "../src/daemon.ts";
import {
  PUSH_EXCERPT_CHARS,
  PushDispatcher,
  PushRateLimit,
  buildPushRequest,
  channelWants,
  composePush,
  matchPushRules,
  neutraliseMarkdown,
  pushEventFor,
  sendPush,
} from "../src/push.ts";

/**
 * Push notifications (ADR 0028). Every send goes to a real HTTP server on
 * loopback, so the request a chat provider would receive is the one asserted.
 */

const exec = promisify(execFile);

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");
const SELF = { agentId: "alice-cursor", machineId: "alice-mbp" };

interface Received {
  path: string;
  body: Record<string, unknown>;
}

/** A loopback endpoint that records every POST and answers with `reply`. */
class Sink {
  readonly received: Received[] = [];
  reply: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (raw += chunk));
      req.on("end", () => {
        this.received.push({
          path: req.url ?? "",
          body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
        this.reply(req, res);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function header(overrides: Partial<MessageHeader> = {}): MessageHeader {
  return {
    v: 1,
    id: "01JB0000000000000000000000",
    room: "architecture",
    from: "bob-codex",
    authorKind: "agent",
    ts: "2026-11-02T10:00:00.000Z",
    kind: "msg",
    thread: "01JB0000000000000000000000",
    needs: "none",
    mentions: [],
    priority: "normal",
    tags: [],
    refs: [],
    extra: {},
    ...overrides,
  };
}

function message(overrides: Partial<MessageHeader> = {}, body = "hello"): Message {
  return { header: header(overrides), body };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "01JB1111111111111111111111",
    state: "completed",
    action: "completed",
    creator: SELF.agentId,
    title: "Ledger migration",
    assignee: "bob-codex",
    staleAfterSeconds: 86_400,
    ...overrides,
  };
}

function channel(overrides: Partial<PushChannel> = {}): PushChannel {
  return {
    name: "team",
    format: "json",
    url: "http://127.0.0.1:1/hook",
    events: ["needs-human", "task-completed", "task-blocked"],
    maxPerHour: 30,
    ...overrides,
  };
}

describe("push routing rules", () => {
  it("matches needs-human, the outcome of tasks this agent created, and mentions", () => {
    assert.deepEqual(matchPushRules(message({ needs: "human" }), SELF), ["needs-human", "all"]);
    assert.deepEqual(matchPushRules(message({ task: task() }), SELF), ["task-completed", "all"]);
    assert.deepEqual(matchPushRules(message({ task: task({ state: "stuck" }) }), SELF), [
      "task-blocked",
      "all",
    ]);
    assert.deepEqual(matchPushRules(message({ mentions: ["machine:alice-mbp"] }), SELF), [
      "mentions",
      "all",
    ]);
    assert.deepEqual(matchPushRules(message(), SELF), ["all"]);
  });

  it("ignores the outcome of a task somebody else created", () => {
    // The creator asked for the work; a bystander did not.
    const rules = matchPushRules(message({ task: task({ creator: "carol-claude" }) }), SELF);
    assert.deepEqual(rules, ["all"]);
  });

  it("pushes only what a channel subscribed to; the default skips chatter and mentions", () => {
    const quiet = channel();
    assert.ok(channelWants(quiet, matchPushRules(message({ needs: "human" }), SELF)));
    assert.ok(!channelWants(quiet, matchPushRules(message({ mentions: [SELF.agentId] }), SELF)));
    assert.ok(!channelWants(quiet, matchPushRules(message(), SELF)));
    assert.ok(channelWants(channel({ events: ["all"] }), matchPushRules(message(), SELF)));
  });

  it("marks needs-human and blocking as urgent", () => {
    assert.equal(pushEventFor(message({ needs: "human" }), "acme", SELF).urgent, true);
    assert.equal(pushEventFor(message({ priority: "blocking" }), "acme", SELF).urgent, true);
    assert.equal(pushEventFor(message({ task: task() }), "acme", SELF).urgent, false);
  });
});

describe("push content", () => {
  it("carries room, sender, task id and title, and trims the body", () => {
    const event = pushEventFor(message({ task: task() }, "x".repeat(2_000)), "acme", SELF);
    const text = composePush(event);
    assert.equal(text.title, "Task completed · #architecture");
    assert.ok(text.facts.includes("from bob-codex"));
    assert.ok(text.facts.some((fact) => fact.includes("01JB1111111111111111111111")));
    assert.ok(text.facts.some((fact) => fact.includes("Ledger migration")));
    assert.equal(text.excerpt.length, PUSH_EXCERPT_CHARS);
  });

  it("drops a body the secret scanner flags, and never sends any part of the secret", () => {
    const secret = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const event = pushEventFor(
      message({ needs: "human" }, `deploy is stuck, use ${secret} to retry`),
      "acme",
      SELF,
    );
    for (const format of ["json", "wecom", "feishu", "telegram"] as const) {
      const request = buildPushRequest(
        channel({ format, ...(format === "telegram" ? { token: "t", chatId: "1" } : {}) }),
        event,
      );
      const wire = JSON.stringify(request.body);
      assert.ok(!wire.includes(secret), `${format} leaked the secret`);
      assert.ok(!wire.includes("ghp_"), `${format} leaked part of the secret`);
      assert.match(wire, /withheld/);
    }
  });

  it("builds each provider's body shape", () => {
    const event = pushEventFor(message({ needs: "human" }, "Ship it?"), "acme", SELF);

    const wecom = buildPushRequest(channel({ format: "wecom", url: "http://x/send?key=k" }), event);
    const wecomBody = wecom.body as { msgtype: string; markdown: { content: string } };
    assert.equal(wecomBody.msgtype, "markdown");
    assert.match(wecomBody.markdown.content, /Decision needed/);
    assert.match(wecomBody.markdown.content, /Ship it\?/);

    const feishu = buildPushRequest(channel({ format: "feishu", url: "http://x/hook" }), event);
    const feishuBody = feishu.body as { msg_type: string; content: { text: string } };
    assert.equal(feishuBody.msg_type, "text");
    assert.match(feishuBody.content.text, /Ship it\?/);

    const signed = buildPushRequest(
      channel({ format: "feishu", url: "http://x/hook", secret: "s3cr3t" }),
      event,
      1_700_000_000_000,
    );
    const signedBody = signed.body as { timestamp: string; sign: string };
    assert.equal(signedBody.timestamp, "1700000000");
    assert.match(signedBody.sign, /^[A-Za-z0-9+/]+=*$/);
    assert.ok(!JSON.stringify(signed.body).includes("s3cr3t"), "the signing secret is not sent");

    const telegram = buildPushRequest(
      channel({ format: "telegram", token: "123:abc", chatId: "42", apiUrl: "http://t/" }),
      event,
    );
    assert.equal(telegram.url, "http://t/bot123:abc/sendMessage");
    const telegramBody = telegram.body as { chat_id: string; text: string; parse_mode?: string };
    assert.equal(telegramBody.chat_id, "42");
    assert.equal(telegramBody.parse_mode, undefined, "plain text, so a body cannot inject markup");
  });

  it("stops a message body from forging WeCom markup", () => {
    const forged = neutraliseMarkdown(
      '[click](http://evil) <font color="warning">**oguri**</font>',
    );
    assert.ok(!/[<>[\]*]/.test(forged), forged);
  });
});

describe("push delivery over HTTP", () => {
  const sink = new Sink();
  let base: string;

  before(async () => {
    base = await sink.start();
  });
  after(async () => {
    await sink.stop();
  });

  it("posts to the endpoint and reports success", async () => {
    sink.received.length = 0;
    const result = await sendPush(
      channel({ url: `${base}/hook` }),
      pushEventFor(message({ needs: "human" }), "acme", SELF),
    );
    assert.deepEqual(result, { channel: "team", ok: true });
    assert.equal(sink.received.length, 1);
    assert.equal(sink.received[0]?.body["room"], "architecture");
    assert.equal(sink.received[0]?.body["event"], "needs-human");
  });

  it("treats a provider's error code as a failure even on HTTP 200", async () => {
    sink.reply = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" }));
    };
    try {
      const result = await sendPush(
        channel({ format: "wecom", url: `${base}/cgi-bin/webhook/send?key=SECRETKEY` }),
        pushEventFor(message({ needs: "human" }), "acme", SELF),
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /errcode 93000/);
      assert.ok(!(result.error ?? "").includes("SECRETKEY"), "the error never names the key");
    } finally {
      sink.reply = (_req, res) => {
        res.writeHead(200);
        res.end("{}");
      };
    }
  });

  it("gives up at the timeout instead of hanging the caller", async () => {
    sink.reply = () => undefined; // never answers
    try {
      const started = Date.now();
      const result = await sendPush(
        channel({ url: `${base}/slow` }),
        pushEventFor(message({ needs: "human" }), "acme", SELF),
        { timeoutMs: 200 },
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /timed out/);
      assert.ok(Date.now() - started < 5_000);
    } finally {
      sink.reply = (_req, res) => {
        res.writeHead(200);
        res.end("{}");
      };
    }
  });

  it("reports an unreachable endpoint without throwing", async () => {
    const result = await sendPush(
      channel({ url: "http://127.0.0.1:1/hook" }),
      pushEventFor(message({ needs: "human" }), "acme", SELF),
    );
    assert.equal(result.ok, false);
    assert.ok(result.error !== undefined);
  });

  it("routes per channel, applies the hourly cap, and lets urgent pushes through", async () => {
    sink.received.length = 0;
    const logs: string[] = [];
    let now = 1_000_000;
    const channels = [
      channel({ name: "phone", url: `${base}/phone`, maxPerHour: 2, events: ["all"] }),
      channel({ name: "team", url: `${base}/team`, events: ["needs-human"] }),
    ];
    const dispatcher = new PushDispatcher({
      loadChannels: async () => channels,
      log: (line) => logs.push(line),
      now: () => now,
    });

    dispatcher.deliver("acme", SELF, [message(), message(), message()]);
    await dispatcher.settled();
    assert.equal(sink.received.filter((r) => r.path === "/phone").length, 2, "capped at 2/hour");
    assert.equal(sink.received.filter((r) => r.path === "/team").length, 0, "team skips chatter");
    assert.ok(logs.some((line) => /phone dropped: 2\/hour cap/.test(line)));

    dispatcher.deliver("acme", SELF, [message({ needs: "human" })]);
    await dispatcher.settled();
    assert.equal(sink.received.filter((r) => r.path === "/phone").length, 3, "urgent passes");
    assert.equal(sink.received.filter((r) => r.path === "/team").length, 1);

    now += 60 * 60_000 + 1;
    dispatcher.deliver("acme", SELF, [message()]);
    await dispatcher.settled();
    assert.equal(sink.received.filter((r) => r.path === "/phone").length, 4, "window rolled");
  });

  it("logs a failed channel and keeps going", async () => {
    sink.received.length = 0;
    const logs: string[] = [];
    const dispatcher = new PushDispatcher({
      loadChannels: async () => [
        channel({ name: "broken", url: "http://127.0.0.1:1/x" }),
        channel({ name: "team", url: `${base}/team` }),
      ],
      log: (line) => logs.push(line),
    });
    dispatcher.deliver("acme", SELF, [message({ needs: "human" })]);
    await dispatcher.settled();
    assert.equal(sink.received.length, 1);
    assert.ok(logs.some((line) => line.startsWith("push to broken failed")));
  });

  it("survives an unreadable policy", async () => {
    const logs: string[] = [];
    const dispatcher = new PushDispatcher({
      loadChannels: async () => {
        throw new Error("policy.yaml: bad");
      },
      log: (line) => logs.push(line),
    });
    dispatcher.deliver("acme", SELF, [message({ needs: "human" })]);
    await dispatcher.settled();
    assert.ok(logs.some((line) => /push skipped: policy unreadable/.test(line)));
  });
});

describe("push rate limit", () => {
  it("counts urgent pushes against the window but never refuses them", () => {
    const limit = new PushRateLimit();
    const ch = channel({ maxPerHour: 1 });
    assert.ok(limit.take(ch, true, 0));
    assert.ok(!limit.take(ch, false, 1));
    assert.ok(limit.take(ch, true, 2));
  });
});

// ------------------------------------------------------------------ end to end

async function oguri(home: string, ...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1" },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("daemon delivery pushes to the policy's channels", () => {
  let tmp: string;
  let remote: string;
  let aliceHome: string;
  let bobHome: string;
  const sink = new Sink();
  let base: string;

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oguri-push-"));
    remote = join(tmp, "transport.git");
    aliceHome = join(tmp, "alice");
    bobHome = join(tmp, "bob");
    base = await sink.start();
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    const init = (home: string, agent: string) =>
      oguri(home, "init", "--repo", remote, "--network", "acme", "--agent", agent);
    assert.equal((await init(aliceHome, "alice-cursor")).code, 0);
    assert.equal((await oguri(aliceHome, "room", "create", "architecture")).code, 0);
    assert.equal((await init(bobHome, "bob-codex")).code, 0);
    assert.equal((await oguri(bobHome, "room", "join", "architecture")).code, 0);
  });

  after(async () => {
    await sink.stop();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("sends a needs-human arrival and the outcome of a delegated task, and nothing else", async () => {
    await writeFile(
      join(aliceHome, "policy.yaml"),
      `notifications:\n  channels:\n    team:\n      format: json\n      url: ${base}/hook\n`,
      "utf8",
    );
    const layout = new Layout(aliceHome);
    const daemon = new Daemon({ layout, notifier: "none", autoSync: false, log: () => undefined });
    await daemon.start();
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      // Created through the daemon, so alice is the creator of record.
      const created = await client.request<{ header: { task: { id: string } } }>("taskCreate", {
        room: "architecture",
        input: { title: "Ledger migration", definition: "Move the ledger.", target: "bob-codex" },
      });
      const taskId = created.header.task.id;

      assert.equal(
        (await oguri(bobHome, "send", "architecture", "just chatting", "--mention", "alice-cursor"))
          .code,
        0,
      );
      assert.equal(
        (
          await oguri(
            bobHome,
            "ask",
            "architecture",
            "Drop the legacy table?",
            "--needs",
            "human",
            "--mention",
            "alice-cursor",
          )
        ).code,
        0,
      );
      const synced = await oguri(bobHome, "sync");
      assert.equal(synced.code, 0, synced.out);
      const approved = await oguri(bobHome, "task", "approve", "architecture", taskId);
      assert.equal(approved.code, 0, approved.out);
      const claimed = await oguri(bobHome, "task", "claim", "architecture", taskId, "Mine.");
      assert.equal(claimed.code, 0, claimed.out);
      const started = await oguri(
        bobHome,
        "task",
        "update",
        "architecture",
        taskId,
        "started",
        "Go.",
      );
      assert.equal(started.code, 0, started.out);
      const done = await oguri(
        bobHome,
        "task",
        "update",
        "architecture",
        taskId,
        "completed",
        "Done.",
      );
      assert.equal(done.code, 0, done.out);

      sink.received.length = 0;
      await client.request("sync");
      await daemon.push.settled();

      const events = sink.received.map((r) => r.body["event"]);
      assert.ok(events.includes("needs-human"), `got ${JSON.stringify(events)}`);
      assert.ok(events.includes("task-completed"), `got ${JSON.stringify(events)}`);
      assert.ok(!events.includes("mentions"), "mentions are opt-in");
      const completed = sink.received.find((r) => r.body["event"] === "task-completed");
      assert.equal((completed?.body["task"] as { id: string } | undefined)?.id, taskId);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it("does not crash the daemon when the endpoint is down", async () => {
    await writeFile(
      join(aliceHome, "policy.yaml"),
      "notifications:\n  channels:\n    dead:\n      format: json\n      url: http://127.0.0.1:1/x\n",
      "utf8",
    );
    const layout = new Layout(aliceHome);
    const logs: string[] = [];
    const daemon = new Daemon({
      layout,
      notifier: "none",
      autoSync: false,
      log: (line) => logs.push(line),
    });
    await daemon.start();
    const client = await DaemonClient.connect(layout.socketPath);
    try {
      assert.equal(
        (
          await oguri(
            bobHome,
            "ask",
            "architecture",
            "Still there?",
            "--needs",
            "human",
            "--mention",
            "alice-cursor",
          )
        ).code,
        0,
      );
      await client.request("sync");
      await daemon.push.settled();
      assert.ok(
        logs.some((line) => /push to dead failed/.test(line)),
        logs.join("\n"),
      );
      const pong = await client.request<{ pong: boolean }>("ping");
      assert.equal(pong.pong, true);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  it("does not count a passive client as an agent at the keyboard", async () => {
    // The dashboard polls every few seconds. If that counted as an agent
    // nearby, an open browser tab would keep the cadence hot and silence the
    // desktop notification for every direct mention.
    const layout = new Layout(aliceHome);
    const daemon = new Daemon({ layout, notifier: "none", autoSync: false, log: () => undefined });
    await daemon.start();
    try {
      const passive = await DaemonClient.connect(layout.socketPath);
      passive.passive = true;
      await passive.request("status");
      passive.close();
      assert.equal(daemon.agentNearby, false);

      const active = await DaemonClient.connect(layout.socketPath);
      await active.request("status");
      active.close();
      await sleep(10);
      assert.equal(daemon.agentNearby, true);
    } finally {
      await daemon.stop();
    }
  });
});
