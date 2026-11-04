import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

/**
 * `oguri_big` end to end (ADR 0031): Claude Code / Codex hands one sentence to
 * the big superagent and reads its replies back in the same conversation.
 *
 * The big role is deliberately NOT started here — starting an agent run is
 * never an MCP server's job. A second, genuinely different agent writes the
 * `from-superagent` reply the way a running big superagent does, and the MCP
 * client reads it. Routing never delivers a message to its own author, so
 * using one agent for both would leave the conversation empty and make the
 * assertion vacuous.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";
process.env["NO_COLOR"] = "1";
// A run started by oguri's own worker asserts its identity and task in the
// environment. These tests make their own homes and agents from scratch, so
// inheriting that assertion would make every child process refuse to act.
delete process.env["OGURI_AGENT"];
delete process.env["OGURI_TASK_ID"];
delete process.env["OGURI_TASK_ROOM"];

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A minimal MCP stdio client; the main suite asserts stdout stays pure JSON-RPC. */
class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(home: string, extra: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [CLI, "mcp", "--direct"], {
      env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1", ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as RpcMessage;
          if (message.id !== undefined) {
            this.pending.get(message.id)?.(message);
            this.pending.delete(message.id);
          }
        } catch {
          // The main MCP test asserts stdout is protocol messages only.
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  async rpc(method: string, params: unknown = {}): Promise<RpcMessage> {
    const id = this.nextId++;
    return await new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oguri-big-test", version: "1.0.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
  }

  async call<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ value: T; isError: boolean }> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const content = (response.result?.["content"] ?? []) as { text: string }[];
    const text = content.map((c) => c.text).join("");
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // A plain-text error from the SDK.
    }
    return {
      value: value as T,
      isError: response.result?.["isError"] === true || response.error !== undefined,
    };
  }

  kill(): void {
    this.child.kill();
  }
}

let tmp: string;
let remote: string;
let home: string;
let bigHome: string;
let client: McpClient;

/** Run the built CLI against one home, without this worker's identity assertion. */
async function oguri(forHome: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [CLI, ...args], {
    env: { ...process.env, OGURI_HOME: forHome, NO_COLOR: "1" },
  });
  return stdout;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-mcp-big-"));
  remote = join(tmp, "transport.git");
  home = join(tmp, "home");
  bigHome = join(tmp, "big-home");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri(home, "init", "--repo", remote, "--network", "acme", "--agent", "coding-agent");
  await oguri(bigHome, "init", "--repo", remote, "--network", "acme", "--agent", "liu-big");
  // A conversation room configured on both machines, and Big enabled on the
  // machine that answers. The policy is machine-local; this test writes it
  // into a temp home, never the repository's policy file.
  await writeFile(
    join(home, "policy.yaml"),
    ["v: 1", "superagent:", "  big:", "    room: superagent", ""].join("\n"),
  );
  await writeFile(
    join(bigHome, "policy.yaml"),
    ["v: 1", "superagent:", "  big:", "    enabled: true", "    room: superagent", ""].join("\n"),
  );
  client = new McpClient(home);
  await client.initialize();
});

after(async () => {
  client.kill();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface Reply {
  id: string;
  from: string;
  ts: string;
  body: string;
  role: "you" | "big";
  inReplyTo?: string;
}

describe("oguri_big", () => {
  it("sends a to-big request into the configured room and reports the thread", async () => {
    const sent = await client.call<{
      sent: string;
      thread: string;
      room: string;
      bigEnabledHere: boolean;
      replyWith: string;
    }>("oguri_big", { action: "send", body: "Rename the save button to Submit" });
    assert.equal(sent.isError, false, JSON.stringify(sent.value));
    assert.match(sent.value.sent, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(sent.value.thread, sent.value.sent, "a first message opens a new thread");
    assert.equal(sent.value.room, "superagent");
    assert.equal(sent.value.bigEnabledHere, false, "this machine does not run Big");
    assert.match(sent.value.replyWith, /oguri_big action=replies/);

    // The form the big superagent reads: a to-big tag, no from-superagent tag,
    // and exactly the sentence the caller supplied.
    const onDisk = await oguri(home, "read", "superagent", "--json");
    const messages = JSON.parse(onDisk) as {
      id: string;
      body: string;
      tags: string[];
      kind: string;
      from: string;
    }[];
    const request = messages.find((message) => message.id === sent.value.sent);
    assert.ok(request, "the request is in the conversation room");
    assert.match(request.body, /Rename the save button to Submit/);
    assert.ok(request.tags.includes("to-big"));
    assert.ok(!request.tags.includes("from-superagent"), "Big must not answer itself");
    assert.equal(request.kind, "msg");
    assert.equal(request.from, "coding-agent");
  });

  it("reads empty replies before Big answers, then only Big's replies in that thread", async () => {
    const first = await client.call<{ thread: string }>("oguri_big", {
      action: "send",
      body: "How many workers are running?",
    });
    const second = await client.call<{ thread: string }>("oguri_big", {
      action: "send",
      body: "And what did they cost?",
    });
    assert.notEqual(first.value.thread, second.value.thread, "two separate conversations");

    const before = await client.call<{
      thread: string;
      bigEnabledHere: boolean;
      messages: Reply[];
      replies: Reply[];
    }>("oguri_big", { action: "replies", thread: first.value.thread });
    assert.equal(before.isError, false, JSON.stringify(before.value));
    assert.equal(before.value.bigEnabledHere, false);
    assert.deepEqual(before.value.replies, [], "no Big answer yet is not an error");
    assert.equal(before.value.messages.length, 1);
    assert.equal(before.value.messages[0]?.role, "you");

    // The reply comes from a genuinely second agent, under the request, with
    // the tag the running big superagent uses. It must follow the room to read
    // and write there; routing never delivers into a room it does not follow.
    await oguri(bigHome, "sync");
    await oguri(bigHome, "room", "join", "superagent");
    await oguri(bigHome, "sync");
    await oguri(
      bigHome,
      "send",
      "superagent",
      "Two workers are running.",
      "--tag",
      "from-superagent",
      "--reply-to",
      first.value.sent,
    );
    await oguri(
      bigHome,
      "send",
      "superagent",
      "Nothing yet.",
      "--tag",
      "from-superagent",
      "--reply-to",
      second.value.sent,
    );
    await oguri(home, "sync");

    const afterReply = await client.call<{
      room: string;
      thread: string;
      bigEnabledHere: boolean;
      messages: Reply[];
      replies: Reply[];
    }>("oguri_big", { action: "replies", thread: first.value.thread });
    assert.equal(afterReply.isError, false, JSON.stringify(afterReply.value));
    assert.equal(afterReply.value.room, "superagent");
    assert.equal(afterReply.value.thread, first.value.thread);
    assert.equal(afterReply.value.messages.length, 2, "request + Big's reply");
    assert.equal(afterReply.value.replies.length, 1, "only Big's message is a reply");
    assert.equal(afterReply.value.replies[0]?.from, "liu-big");
    assert.match(afterReply.value.replies[0]?.body ?? "", /Two workers are running/);
    assert.equal(afterReply.value.replies[0]?.role, "big");
    assert.equal(afterReply.value.replies[0]?.inReplyTo, first.value.sent);

    const other = await client.call<{ replies: Reply[] }>("oguri_big", {
      action: "replies",
      thread: second.value.thread,
    });
    assert.equal(other.value.replies.length, 1);
    assert.match(other.value.replies[0]?.body ?? "", /Nothing yet/);
  });

  it("respects an explicit room and names the missing argument for each action", async () => {
    await oguri(home, "room", "create", "big-elsewhere", "--title", "Big elsewhere");
    const sent = await client.call<{ room: string; thread: string }>("oguri_big", {
      action: "send",
      body: "Over here.",
      room: "big-elsewhere",
    });
    assert.equal(sent.isError, false, JSON.stringify(sent.value));
    assert.equal(sent.value.room, "big-elsewhere");
    const shown = await client.call<{ room: string; messages: Reply[] }>("oguri_big", {
      action: "replies",
      room: "big-elsewhere",
      thread: sent.value.thread,
    });
    assert.equal(shown.isError, false, JSON.stringify(shown.value));
    assert.equal(shown.value.room, "big-elsewhere");
    assert.equal(shown.value.messages.length, 1);

    const missingBody = await client.call<string>("oguri_big", { action: "send" });
    assert.equal(missingBody.isError, true);
    assert.match(String(missingBody.value), /requires `body`/);
    const missingThread = await client.call<string>("oguri_big", { action: "replies" });
    assert.equal(missingThread.isError, true);
    assert.match(String(missingThread.value), /requires `thread`/);
  });
});

describe("oguri_big is an owner's tool", () => {
  it("is not offered inside a worker's run, which could otherwise deploy more workers", async () => {
    const { inWorkerRun } = await import("../src/server.ts");
    assert.equal(inWorkerRun({ OGURI_TASK_ID: "01JAAAAAAAAAAAAAAAAAAAAAAA" }), true);
    assert.equal(inWorkerRun({}), false);

    const names = async (extra: Record<string, string>): Promise<string[]> => {
      const probe = new McpClient(home, extra);
      try {
        await probe.initialize();
        const listed = await probe.rpc("tools/list");
        return ((listed.result?.["tools"] ?? []) as { name: string }[]).map((tool) => tool.name);
      } finally {
        probe.kill();
      }
    };
    assert.ok((await names({})).includes("oguri_big"));
    const inRun = await names({
      OGURI_TASK_ID: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      OGURI_TASK_ROOM: "ops",
    });
    assert.ok(!inRun.includes("oguri_big"), "a worker's run has no oguri_big");
    assert.ok(inRun.includes("oguri_task"), "it keeps its own task tools");
  });

  it("does not let a worker's run rewrite the agent's profile", async () => {
    const probe = new McpClient(home, {
      OGURI_TASK_ID: "01JAAAAAAAAAAAAAAAAAAAAAAA",
      OGURI_TASK_ROOM: "ops",
    });
    try {
      await probe.initialize();
      const called = await probe.rpc("tools/call", {
        name: "oguri_agents",
        arguments: { action: "describe", role: "a worker's own task" },
      });
      const result = called.result as { isError?: boolean; content?: { text: string }[] };
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text ?? "", /does not describe the agent/);
    } finally {
      probe.kill();
    }
  });
});
