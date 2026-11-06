import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import type { Backend } from "@oguri/daemon";

import { taskAsk } from "../src/task-run-tools.ts";

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

describe("task ask wait budget", () => {
  for (const worker of [true, false]) {
    it(
      worker
        ? "caps a worker run at 60s with handoff guidance"
        : "keeps the live session's 3600s budget",
      async (t) => {
        let now = 0;
        const waits: number[] = [];
        t.mock.method(Date, "now", () => now);
        const backend = {
          async call(method: string, params: Record<string, unknown>) {
            if (method === "send") return { header: { id: "question" } };
            assert.equal(method, "waitInbox");
            const query = params["query"] as { timeoutMs: number };
            waits.push(query.timeoutMs);
            now += query.timeoutMs;
            return { items: [], timedOut: true };
          },
        } as unknown as Backend;
        const response = await taskAsk(
          backend,
          { question: "Which database?", room: "ops", taskId: "task", waitSec: 3600 },
          worker ? { OGURI_TASK_ID: "task", OGURI_TASK_ROOM: "ops" } : {},
        );
        const value = JSON.parse(response.content[0]?.text ?? "") as {
          answered: boolean;
          note: string;
          guidance?: string;
        };
        assert.equal(value.answered, false);
        assert.equal(
          waits.reduce((sum, ms) => sum + ms, 0),
          (worker ? 60 : 3600) * 1000,
        );
        assert.match(value.note, worker ? /no reply within 60s/ : /no reply within 3600s/);
        if (worker) {
          assert.equal(
            value.guidance,
            "ask 已发出；要等答复的话，写好 result.json 的 needsHuman 后结束本次运行，答复会作为 follow-up 回来",
          );
        } else {
          assert.equal(value.guidance, undefined);
        }
      },
    );
  }
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
    assert.match(JSON.stringify(result.value), /needsHuman.*follow-up/);

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
    // A run's task is always held by the worker that started it.
    await oguri("task", "claim", "ops", chatTask, "taking it");
    await oguri("task", "update", "ops", chatTask, "started", "run started");
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

// ------------------------------------------------------------ run scope

/**
 * What a run may write (ADR 0036), with a genuinely second agent: alice asks,
 * bob's worker runs. Every run on bob's machine is bob, so "the assignee is
 * me" proves nothing; the run's own task in its environment is what decides.
 */
describe("a worker run's writes are scoped to its own task", () => {
  let scopeTmp: string;
  let aliceHome: string;
  let bobHome: string;

  const as = async (who: string, ...args: string[]): Promise<string> => {
    const { stdout } = await exec(process.execPath, [CLI, ...args, "--direct"], {
      env: { ...process.env, OGURI_HOME: who, NO_COLOR: "1" },
    });
    return stdout;
  };
  const alice = (...args: string[]) => as(aliceHome, ...args);
  const bob = (...args: string[]) => as(bobHome, ...args);

  interface Detail {
    task: { id: string; state: string; parent?: string };
    events: { action: string; body: string }[];
    children: { id: string; state: string }[];
  }
  const show = async (id: string): Promise<Detail> => {
    await bob("sync");
    return JSON.parse(await bob("task", "show", "ops", id, "--json")) as Detail;
  };
  const roomTasks = async (): Promise<unknown[]> =>
    JSON.parse(await bob("task", "list", "ops", "--json")) as unknown[];
  const createdId = (value: unknown): string =>
    (value as { header: { task: { id: string } } }).header.task.id;

  /** Alice asks bob for something, and bob holds it as a worker holds a run's task. */
  const assigned = async (title: string): Promise<string> => {
    const created = JSON.parse(
      await alice(
        "task",
        "create",
        "ops",
        `${title}.`,
        "--title",
        title,
        "--target",
        "bob-claude",
        "--json",
      ),
    ) as { task: { id: string } };
    const id = created.task.id;
    await bob("sync");
    // The test home's own approval record, as worker-graph.test.ts does.
    await bob("task", "approve", "ops", id);
    await bob("task", "claim", "ops", id, "taking it");
    await bob("task", "update", "ops", id, "started", "run started");
    return id;
  };

  const runOn = async (taskId: string): Promise<McpClient> => {
    const client = new McpClient(bobHome, { OGURI_TASK_ROOM: "ops", OGURI_TASK_ID: taskId });
    await client.initialize();
    return client;
  };

  before(async () => {
    scopeTmp = await mkdtemp(join(tmpdir(), "oguri-mcp-scope-"));
    const remote = join(scopeTmp, "transport.git");
    aliceHome = join(scopeTmp, "alice");
    bobHome = join(scopeTmp, "bob");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    await alice("init", "--repo", remote, "--network", "acme", "--agent", "alice-claude");
    await alice("room", "create", "ops", "--title", "Ops");
    await bob("init", "--repo", remote, "--network", "acme", "--agent", "bob-claude");
    await bob("room", "join", "ops");
    const runner = [
      process.execPath,
      join(import.meta.dirname, "fixtures", "plan-runner.cjs"),
      CLI,
    ];
    await writeFile(
      join(bobHome, "policy.yaml"),
      [
        "v: 1",
        "worker:",
        "  enabled: true",
        "  timeoutMinutes: 2",
        `  workdir: ${JSON.stringify(scopeTmp)}`,
        "  runners:",
        `    planner: ${JSON.stringify(runner)}`,
        "  trustedRequesters: [alice-claude]",
        "  maxTaskDepth: 1",
        "",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(scopeTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("puts every step of a run's plan under its task: progressed, then rolled up", async () => {
    const created = JSON.parse(
      await alice(
        "task",
        "create",
        "ops",
        "Ship it in parts.",
        "--title",
        "Ship",
        "--target",
        "bob-claude",
        "--json",
      ),
    ) as { task: { id: string } };
    const id = created.task.id;
    await bob("sync");
    const count = (await roomTasks()).length;

    const pass = await bob("worker", "start", "--once");
    assert.match(pass, new RegExp(id));
    const detail = await show(id);
    assert.equal(detail.task.state, "in_progress", "not completed while its subtasks are open");
    const last = detail.events.at(-1);
    assert.equal(last?.action, "progressed", JSON.stringify(detail.events));
    assert.match(last?.body ?? "", /Waiting for 2 subtask\(s\)/);
    assert.equal(detail.children.length, 2);
    assert.equal((await roomTasks()).length, count + 2, "no unrelated parent task was created");
    for (const child of detail.children) {
      assert.equal((await show(child.id)).task.parent, id, "each step's parent is the run's task");
    }

    // The steps finish; the worker's next pass rolls the run's task up (design 14 §9).
    for (const child of detail.children) {
      await bob("task", "claim", "ops", child.id, "doing the step");
      await bob("task", "update", "ops", child.id, "started", "on it");
      await bob("task", "update", "ops", child.id, "completed", "done");
    }
    await bob("worker", "start", "--once");
    assert.equal((await show(id)).task.state, "completed");
  });

  it("refuses a subtask past worker.maxTaskDepth and points to handback", async () => {
    const root = await assigned("Deep");
    const run = await runOn(root);
    let child: string;
    try {
      // No parent given: it goes under the run's own task, at depth 1.
      const made = await run.call("oguri_task", {
        action: "create",
        title: "Level one",
        definition: "One level down.",
      });
      assert.equal(made.isError, false, JSON.stringify(made.value));
      child = createdId(made.value);
      assert.equal((await show(child)).task.parent, root);

      const sideways = await run.call("oguri_task", {
        action: "create",
        title: "Sideways",
        definition: "Under another task.",
        parent: child,
      });
      assert.equal(sideways.isError, true);
      assert.match(JSON.stringify(sideways.value), /is a subtask of/);
    } finally {
      run.kill();
    }

    await bob("task", "approve", "ops", child);
    await bob("task", "claim", "ops", child, "taking the subtask");
    await bob("task", "update", "ops", child, "started", "run started");
    const nested = await runOn(child);
    try {
      const count = (await roomTasks()).length;
      const deeper = await nested.call("oguri_task", {
        action: "create",
        title: "Level two",
        definition: "Too deep.",
      });
      assert.equal(deeper.isError, true);
      assert.match(JSON.stringify(deeper.value), /past worker\.maxTaskDepth \(1\)/);
      assert.match(JSON.stringify(deeper.value), /handback/);
      const plan = await nested.call("oguri_task", {
        action: "plan",
        plan: { title: "Deeper", tasks: [{ key: "x", title: "X", body: "x" }] },
      });
      assert.equal(plan.isError, true);
      assert.match(JSON.stringify(plan.value), /maxTaskDepth/);
      assert.equal((await roomTasks()).length, count, "nothing was written");
    } finally {
      nested.kill();
    }
  });

  it("refuses to update or claim a task that is not its own or a subtask", async () => {
    const mine = await assigned("Mine");
    // Another task bob holds: the same identity, another run's work.
    const sibling = await assigned("Sibling");
    const hers = JSON.parse(
      await alice("task", "create", "ops", "Alice's own.", "--title", "Hers", "--json"),
    ) as { task: { id: string } };
    await alice("task", "claim", "ops", hers.task.id, "mine");
    await alice("task", "update", "ops", hers.task.id, "started", "working");
    const free = JSON.parse(
      await alice("task", "create", "ops", "Anyone.", "--title", "Free", "--json"),
    ) as { task: { id: string } };
    await bob("sync");

    const run = await runOn(mine);
    try {
      const updates: [string, string][] = [
        [hers.task.id, "progressed"],
        [sibling, "progressed"],
        [sibling, "completed"],
      ];
      for (const [taskId, transition] of updates) {
        const result = await run.call("oguri_task", {
          action: "update",
          taskId,
          transition,
          body: "trying",
        });
        assert.equal(result.isError, true, `${transition} on ${taskId} was accepted`);
        assert.match(JSON.stringify(result.value), /neither this run's task/);
      }
      const claim = await run.call("oguri_task", {
        action: "claim",
        taskId: free.task.id,
        note: "taking more work",
      });
      assert.equal(claim.isError, true);
      assert.match(JSON.stringify(claim.value), /handback/);
      const progress = await run.call("oguri_task", {
        action: "progress",
        taskId: sibling,
        body: "on another task",
      });
      assert.equal(progress.isError, true);
      assert.match(JSON.stringify(progress.value), /run's own task/);
      // Its requester's powers stay its requester's: no rewriting its own runner header.
      const refine = await run.call("oguri_task", {
        action: "update",
        taskId: mine,
        transition: "refined",
        body: "runner: opus\nDo more.",
      });
      assert.equal(refine.isError, true);
      assert.match(JSON.stringify(refine.value), /requester's to make/);
      const request = await run.call("oguri_runner", {
        action: "request",
        runner: "planner",
        reason: "for alice's task",
        taskId: hers.task.id,
      });
      assert.equal(request.isError, true);
      assert.match(JSON.stringify(request.value), /only its own task/);
    } finally {
      run.kill();
    }
    assert.equal((await show(hers.task.id)).events.at(-1)?.action, "started");
    assert.equal((await show(sibling)).task.state, "in_progress");
    assert.equal((await show(free.task.id)).task.state, "open");
  });

  it("refuses every write once its task is cancelled", async () => {
    const id = await assigned("Doomed");
    const run = await runOn(id);
    try {
      const made = await run.call("oguri_task", {
        action: "create",
        title: "A part",
        definition: "Part of it.",
      });
      assert.equal(made.isError, false, JSON.stringify(made.value));
      const child = createdId(made.value);

      await alice("sync");
      await alice("task", "update", "ops", id, "cancelled", "not needed any more");
      await bob("sync");
      const count = (await roomTasks()).length;

      const attempts: [string, Record<string, unknown>][] = [
        ["oguri_task", { action: "progress", body: "still going" }],
        ["oguri_task", { action: "ask", question: "Should I go on?" }],
        ["oguri_task", { action: "handback", body: "This is beyond the task." }],
        ["oguri_task", { action: "create", title: "More", definition: "More work." }],
        [
          "oguri_task",
          { action: "plan", plan: { title: "P", tasks: [{ key: "a", title: "A", body: "a" }] } },
        ],
        ["oguri_task", { action: "claim", taskId: child, note: "taking my part" }],
        ["oguri_task", { action: "update", taskId: child, transition: "cancelled", body: "tidy" }],
        ["oguri_send", { room: "ops", body: "An update." }],
        ["oguri_runner", { action: "request", runner: "planner", reason: "need it" }],
      ];
      for (const [tool, args] of attempts) {
        const result = await run.call(tool, args);
        assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)} was accepted`);
        assert.match(JSON.stringify(result.value), /was cancelled/);
      }
      assert.equal((await roomTasks()).length, count, "no task was written");
      assert.equal((await show(child)).task.state, "open");
    } finally {
      run.kill();
    }
  });
});
