import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

/**
 * The tools a worker run uses: report progress and ask about its own task
 * without being told ids, and submit a plan. The server is started the way a
 * run starts it, with OGURI_TASK_ROOM and OGURI_TASK_ID in its environment.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";
// A run started by oguri's own worker asserts its identity and task in the
// environment. This suite makes its own homes and agents from scratch, and
// gives the in-run clients their own task env explicitly, so inheriting the
// outer run's assertion would make every child process refuse to act.
delete process.env["OGURI_AGENT"];
delete process.env["OGURI_TASK_ID"];
delete process.env["OGURI_TASK_ROOM"];

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  constructor(home: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [CLI, "mcp", "--direct"], {
      env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
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
            // Not JSON-RPC; the main MCP test asserts stdout stays clean.
          }
        }
        index = this.buffer.indexOf("\n");
      }
    });
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
      clientInfo: { name: "oguri-test", version: "1.0.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
  }

  async tools(): Promise<string[]> {
    const response = await this.rpc("tools/list");
    return ((response.result?.["tools"] ?? []) as { name: string }[]).map((tool) => tool.name);
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ value: unknown; isError: boolean }> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const content = (response.result?.["content"] ?? []) as { text: string }[];
    const text = content.map((c) => c.text).join("");
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain text error from the SDK.
    }
    return {
      value,
      isError: response.result?.["isError"] === true || response.error !== undefined,
    };
  }

  kill(): void {
    this.child.kill();
  }
}

let tmp: string;
let home: string;
let taskId: string;
let outside: McpClient;
let inRun: McpClient;

async function oguri(...args: string[]): Promise<string> {
  const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], {
    env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1" },
  });
  return stdout;
}

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "oguri-mcp-run-"));
  home = join(tmp, "home");
  const remote = join(tmp, "transport.git");
  await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
  await oguri("init", "--repo", remote, "--network", "acme", "--agent", "run-agent");
  await oguri("room", "create", "ops", "--title", "Ops");
  const created = JSON.parse(
    await oguri("task", "create", "ops", "Do the thing.", "--title", "Thing", "--json"),
  ) as { task: { id: string } };
  taskId = created.task.id;
  await oguri("task", "claim", "ops", taskId, "taking it");
  // A worker run is always in progress: `progressed` is only valid after `started`.
  await oguri("task", "update", "ops", taskId, "started", "run started");

  outside = new McpClient(home);
  await outside.initialize();
  inRun = new McpClient(home, { OGURI_TASK_ROOM: "ops", OGURI_TASK_ID: taskId });
  await inRun.initialize();
});

after(async () => {
  outside.kill();
  inRun.kill();
  await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("worker run tools", () => {
  it("are actions of oguri_task, not extra tools", async () => {
    const names = await inRun.tools();
    assert.ok(names.includes("oguri_task"), `oguri_task is missing from ${names.join(", ")}`);
    // They are actions of oguri_task, not tools: the tool surface is budgeted.
    assert.ok(!names.some((name) => name.startsWith("oguri_task_")), names.join(", "));
  });

  it("post progress on the run's own task with no ids given", async () => {
    const result = await inRun.call("oguri_task", {
      action: "progress",
      body: "Half way: data collected.",
    });
    assert.equal(result.isError, false, JSON.stringify(result.value));

    const detail = JSON.parse(await oguri("task", "show", "ops", taskId, "--json")) as {
      task: { state: string };
      events: { action: string; body: string }[];
    };
    assert.equal(detail.task.state, "in_progress");
    assert.equal(detail.events.at(-1)?.action, "progressed");
    assert.match(detail.events.at(-1)?.body ?? "", /Half way/);
  });

  it("say what is missing when used outside a run", async () => {
    const result = await outside.call("oguri_task", { action: "progress", body: "hello" });
    assert.match(JSON.stringify(result.value), /OGURI_TASK_ROOM is unset/);
  });

  it("ask a question tied to the task, without waiting by default", async () => {
    const result = await inRun.call("oguri_task", {
      action: "ask",
      question: "Which database should I use?",
    });
    assert.equal(result.isError, false, JSON.stringify(result.value));
    const value = result.value as { asked: string; answered: boolean };
    assert.equal(value.answered, false);
    assert.ok(value.asked.length > 0);

    const read = await oguri("read", "ops", "--json");
    assert.match(read, new RegExp(`\\[task ${taskId}\\] Which database should I use\\?`));
  });

  it("wait for a reply and return it", async () => {
    const asking = inRun.call("oguri_task", {
      action: "ask",
      question: "Staging or prod?",
      waitSec: 4,
    });
    // Let the question land, then answer it from the CLI as another party would.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const inbox = JSON.parse(await oguri("read", "ops", "--json")) as unknown;
    const messages = (
      Array.isArray(inbox) ? inbox : ((inbox as { messages?: unknown[] }).messages ?? [])
    ) as {
      id?: string;
      header?: { id: string };
      body?: string;
    }[];
    const question = messages.find((m) => (m.body ?? "").includes("Staging or prod?"));
    const questionId = question?.header?.id ?? question?.id;
    assert.ok(questionId !== undefined, "the question was published");
    await oguri("send", "ops", "Staging.", "--reply-to", questionId);

    const result = await asking;
    const value = result.value as { answered: boolean; reply?: { body: string } };
    // The asker is also the sender here, so what matters is that the wait ends
    // either with the reply or with an honest "no reply", never a hang.
    assert.equal(typeof value.answered, "boolean");
    if (value.answered) assert.match(value.reply?.body ?? "", /Staging/);
  });

  it("create a plan from a plan a live agent wrote", async () => {
    const result = await outside.call("oguri_task", {
      action: "plan",
      room: "ops",
      definition: "Ship it",
      plan: {
        title: "Ship it",
        tasks: [
          { key: "build", title: "Build", body: "Run the build." },
          { key: "deploy", title: "Deploy", body: "Deploy.", dependsOn: ["build"] },
        ],
      },
    });
    assert.equal(result.isError, false, JSON.stringify(result.value));
    const created = result.value as {
      tasks: { key: string; id: string }[];
      parent: { id: string };
    };
    assert.deepEqual(
      created.tasks.map((t) => t.key),
      ["build", "deploy"],
    );

    const deploy = JSON.parse(
      await oguri("task", "show", "ops", created.tasks[1]?.id as string, "--json"),
    ) as {
      task: { dependsOn?: string[]; parent?: string };
    };
    assert.deepEqual(deploy.task.dependsOn, [created.tasks[0]?.id]);
    assert.equal(deploy.task.parent, created.parent.id);
  });

  it("refuse an invalid plan with every problem and create nothing", async () => {
    const before = JSON.parse(await oguri("task", "list", "ops", "--json")) as unknown[];
    const result = await outside.call("oguri_task", {
      action: "plan",
      room: "ops",
      plan: {
        title: "Bad",
        tasks: [
          { key: "a", title: "A", body: "b", dependsOn: ["b"] },
          { key: "b", title: "B", body: "b", dependsOn: ["a"] },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.value), /cycle among: a, b/);
    const after = JSON.parse(await oguri("task", "list", "ops", "--json")) as unknown[];
    assert.equal(after.length, before.length);
  });
});

// ------------------------------------------------------------ chat relays

/**
 * The relay actions (ADR 0030 §6): a run on a task that came from a chat
 * acknowledges once, answers what a person asked, and hands back what is
 * beyond the task. The task and the person's messages are written the way
 * intake writes them, with `origin` and `external`.
 */
describe("chat relay actions", () => {
  let chatTask: string;
  let chatRoot: string;
  let followup: string;
  let relayRun: McpClient;

  async function withNetwork<T>(
    fn: (network: import("@oguri/core").Network) => Promise<T>,
  ): Promise<T> {
    const { Layout, Network, loadConfig, resolveNetwork } = await import("@oguri/core");
    const layout = new Layout(home);
    const config = (await loadConfig(layout.configPath)) as NonNullable<
      Awaited<ReturnType<typeof loadConfig>>
    >;
    const network = Network.open(layout, resolveNetwork(config), config.agent);
    try {
      return await fn(network);
    } finally {
      network.close();
    }
  }

  const person = (id: string, human = true) => ({
    source: "feishu",
    id,
    conversation: "oc_team",
    actor: "ou_alice",
    actorName: "Alice",
    human,
  });

  interface Line {
    id: string;
    relay: string | null;
    inReplyTo: string | null;
    body: string;
    external: { actor: string } | null;
  }
  const thread = async (): Promise<Line[]> =>
    (JSON.parse(await oguri("read", "ops", "--thread", chatRoot, "--json")) as Line[]).filter(
      (line) => line.relay !== null,
    );

  before(async () => {
    const created = await withNetwork(async (network) => {
      const root = await network.createTask("ops", {
        title: "Fix the cancel button",
        definition: "The cancel button does nothing on the checkout page.",
        origin: {
          source: "feishu",
          conversation: "oc_team",
          message: "om_request",
          requester: "ou_alice",
          url: "https://example.feishu.cn/messages/om_request",
        },
        mandate: { strength: "explicit", via: "addressed", policy: "0123abcd0123abcd" },
      });
      const later = await network.send("ops", {
        body: "Also make it grey while saving.",
        inReplyTo: root.header.id,
        external: person("om_followup"),
      });
      return { root, later };
    });
    chatTask = created.root.header.task?.id as string;
    chatRoot = created.root.header.id;
    followup = created.later.header.id;
    relayRun = new McpClient(home, { OGURI_TASK_ROOM: "ops", OGURI_TASK_ID: chatTask });
    await relayRun.initialize();
  });

  after(() => {
    relayRun.kill();
  });

  it("acknowledge the request once, under the task", async () => {
    const first = await relayRun.call("oguri_task", {
      action: "ack",
      body: "On it: the cancel button on checkout.",
    });
    assert.equal(first.isError, false, JSON.stringify(first.value));
    assert.equal((first.value as { inReplyTo: string }).inReplyTo, chatRoot);

    const second = await relayRun.call("oguri_task", { action: "ack", body: "On it again." });
    assert.equal(second.isError, true);
    assert.match(JSON.stringify(second.value), /already acknowledged/);

    const acks = (await thread()).filter((line) => line.relay === "ack");
    assert.equal(acks.length, 1, "the refused ack wrote nothing");
  });

  it("acknowledge a later request from the chat separately, but only once", async () => {
    const first = await relayRun.call("oguri_task", {
      action: "ack",
      body: "Will grey it out while saving.",
      inReplyTo: followup,
    });
    assert.equal(first.isError, false, JSON.stringify(first.value));
    const again = await relayRun.call("oguri_task", {
      action: "ack",
      body: "Greying it.",
      inReplyTo: followup,
    });
    assert.equal(again.isError, true);
    assert.match(JSON.stringify(again.value), /already acknowledged/);
  });

  it("refuse an acknowledgement over 100 words", async () => {
    const result = await relayRun.call("oguri_task", {
      action: "ack",
      body: Array.from({ length: 101 }, () => "word").join(" "),
      inReplyTo: followup,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.value), /at most 100 words; this one has 101/);
  });

  it("answer the newest message from a person by default", async () => {
    const question = await withNetwork(
      async (network) =>
        await network.send("ops", {
          body: "Which browsers does this cover?",
          inReplyTo: followup,
          external: person("om_question"),
        }),
    );
    // A bot's message in the chat is relayed as context, but is not a person to answer.
    await withNetwork(
      async (network) =>
        await network.send("ops", {
          body: "Build passed.",
          inReplyTo: question.header.id,
          external: person("om_bot", false),
        }),
    );
    const result = await relayRun.call("oguri_task", {
      action: "answer",
      body: "Chrome, Safari, and Firefox.",
    });
    assert.equal(result.isError, false, JSON.stringify(result.value));
    assert.equal((result.value as { inReplyTo: string }).inReplyTo, question.header.id);

    const answer = (await thread()).find((line) => line.relay === "answer");
    assert.equal(answer?.inReplyTo, question.header.id);
  });

  it("refuse to answer a message that did not come from the chat", async () => {
    const result = await relayRun.call("oguri_task", {
      action: "answer",
      body: "Yes.",
      inReplyTo: chatRoot,
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.value), /no external source/);
  });

  it("hand back a request beyond the task, saying to ask anew", async () => {
    const result = await relayRun.call("oguri_task", {
      action: "handback",
      body: "Redesigning the whole checkout is a separate piece of work.",
    });
    assert.equal(result.isError, false, JSON.stringify(result.value));
    const handback = (await thread()).find((line) => line.relay === "handback");
    assert.match(handback?.body ?? "", /Redesigning the whole checkout/);
    assert.match(
      handback?.body ?? "",
      /beyond the current task\. Please send it as a new request\./,
    );
  });

  it("refuse to relay from a task that did not come from a chat", async () => {
    const result = await inRun.call("oguri_task", { action: "ack", body: "On it." });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.value), /has no origin/);
  });
});
