import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_SUPERAGENT_POLICY, DEFAULT_WORKER_POLICY } from "@oguri/core";

import { BIG_KINDS, decide } from "../src/act.ts";
import { BigSuperagent, HANDBACK_TAG, QUESTION_TAG } from "../src/big.ts";
import type { Mind, TurnRequest } from "../src/mind.ts";

/**
 * The big superagent follows its workers as a standing superagent session
 * follows its tickets (ADR 0032): a worker's question reaches the owner at
 * once, a handback is decided afresh and never sent back to the same worker,
 * a pull request's merge is told once, and a decision may read tasks first.
 */

const T1 = "01K00000000000000000000T01";
const PR = "https://github.com/acme/app/pull/42";

interface Msg {
  header: {
    id: string;
    room: string;
    from: string;
    ts: string;
    thread: string;
    inReplyTo?: string;
    tags: string[];
    needs: string;
    mentions: string[];
    kind: string;
  };
  body: string;
}

/** Just enough of `Backend` for the big superagent, in memory. */
class FakeBackend {
  messages: Msg[] = [];
  tasks = new Map<string, Record<string, unknown>>();
  created: Record<string, unknown>[] = [];
  private seq = 100;
  private clock = Date.parse("2026-06-01T10:00:00.000Z");

  id(): string {
    this.seq += 1;
    return `01K${String(this.seq).padStart(23, "0")}`;
  }
  ts(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  add(room: string, from: string, body: string, extra: Partial<Msg["header"]> = {}): Msg {
    const id = this.id();
    const message: Msg = {
      header: {
        id,
        room,
        from,
        ts: this.ts(),
        thread: extra.thread ?? id,
        tags: [],
        needs: "none",
        mentions: [],
        kind: "msg",
        ...extra,
      },
      body,
    };
    this.messages.push(message);
    return message;
  }
  replies(to: string): string[] {
    return this.messages.filter((m) => m.header.inReplyTo === to).map((m) => m.body);
  }
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = ((): unknown => {
      switch (method) {
        case "status":
          return { networkId: "home", subscriptions: ["superagent"] };
        case "sync":
        case "roomJoin":
          return {};
        case "machines":
          return [{ id: "box", agents: [{ id: "box-claude", status: "live", role: null }] }];
        case "profileGet":
          return { capabilities: [] };
        case "read":
          return this.messages.filter(
            (m) =>
              m.header.room === params["room"] &&
              (params["thread"] === undefined || m.header.thread === params["thread"]),
          );
        case "send": {
          const input = params["input"] as Record<string, unknown>;
          return this.add(params["room"] as string, "liu-big", input["body"] as string, {
            ...(input["thread"] === undefined ? {} : { thread: input["thread"] as string }),
            ...(input["inReplyTo"] === undefined
              ? {}
              : { inReplyTo: input["inReplyTo"] as string }),
            tags: (input["tags"] as string[] | undefined) ?? [],
          });
        }
        case "tasks":
          return [...this.tasks.values()].map((detail) => ({ ...detail }));
        case "taskShow":
          return this.tasks.get(params["taskId"] as string) ?? null;
        case "taskCreate": {
          const input = params["input"] as Record<string, unknown>;
          this.created.push(input);
          const id = this.id();
          return { header: { id, thread: id, task: { id } } };
        }
        default:
          throw new Error(`fake backend: ${method}`);
      }
    })();
    return result as T;
  }
  async close(): Promise<void> {}
}

function taskDetail(state: string, events: Record<string, unknown>[]): Record<string, unknown> {
  return {
    task: {
      id: T1,
      title: "Rename the button",
      state,
      creator: "liu-big",
      assignee: "box-claude",
      target: "box-claude",
    },
    thread: T1,
    definition: "Rename the Save button",
    updatedAt: "2026-06-01T10:00:00.000Z",
    health: "active",
    events,
    currentMessageId: (events.at(-1)?.["messageId"] as string | undefined) ?? T1,
  };
}

let home: string;
before(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-big-"));
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seedState(conversation: string): Promise<void> {
  await mkdir(join(home, "superagent"), { recursive: true });
  await writeFile(
    join(home, "superagent", "big.json"),
    JSON.stringify({
      handled: [],
      since: "2026-01-01T00:00:00.000Z",
      tracked: {
        [T1]: {
          room: "superagent",
          conversation: {
            room: "superagent",
            thread: conversation,
            messageId: conversation,
            author: "liu",
          },
        },
      },
      noted: {},
    }),
  );
}

const policy = {
  superagent: {
    ...DEFAULT_SUPERAGENT_POLICY,
    big: { ...DEFAULT_SUPERAGENT_POLICY.big, enabled: true, runner: "brain", coordinate: false },
  },
  worker: { ...DEFAULT_WORKER_POLICY, runners: { brain: { argv: ["brain"], worktree: false } } },
};

describe("the big superagent follows its workers", () => {
  it("passes on a worker's question at once, decides a handback afresh, and tells a merge once", async () => {
    const backend = new FakeBackend();
    const asked = backend.add("superagent", "liu", "Rename the Save button", { tags: ["to-big"] });
    await seedState(asked.header.id);
    backend.tasks.set(
      T1,
      taskDetail("in_progress", [
        {
          messageId: "E1",
          ts: "2026-06-01T10:00:00.000Z",
          action: "started",
          body: "Run started.",
          refs: [],
        },
      ]),
    );
    backend.add("superagent", "box-claude", "Blue or green for the new label?", {
      thread: T1,
      tags: [QUESTION_TAG],
      needs: "human",
    });
    backend.add("superagent", "box-claude", "They also want the docs site rebuilt.", {
      thread: T1,
      tags: [HANDBACK_TAG],
    });
    backend.messages.find((m) => m.header.id === asked.header.id)!.header.tags = ["handled"];

    const prompts: string[] = [];
    const answers = [
      // A handback sent back to its own worker is refused.
      { kind: "attach", taskId: T1, reason: "same" },
    ];
    let gh = "OPEN";
    const big = new BigSuperagent({
      backend: backend as never,
      agentId: "liu-big",
      home,
      loadPolicy: async () => policy,
      ask: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          ok: true,
          stdout: JSON.stringify(answers.shift() ?? { kind: "ignore", reason: "x" }),
        };
      },
      gh: async () => JSON.stringify({ state: gh, url: PR }),
    });

    await big.pass();
    const told = backend.replies(asked.header.id);
    assert.ok(
      told.some((t) =>
        t.startsWith("Question from the worker on Rename the button:\nBlue or green"),
      ),
      JSON.stringify(told),
    );
    assert.ok(
      told.some((t) => /handed something back that I could not place/.test(t)),
      JSON.stringify(told),
    );
    assert.match(
      prompts[0] ?? "",
      /handed this back as beyond its task: They also want the docs site rebuilt\./,
    );

    // The worker finishes with a pull request; the owner is told once, then the merge once.
    backend.tasks.set(
      T1,
      taskDetail("completed", [
        {
          messageId: "E2",
          ts: new Date().toISOString(),
          action: "completed",
          body: `Renamed it. ${PR}`,
          refs: [PR],
        },
      ]),
    );
    await big.pass();
    gh = "MERGED";
    // The PR is checked at most every few minutes: a pass right after does not ask.
    await big.pass();
    assert.equal(
      backend.replies(asked.header.id).filter((t) => t.startsWith("PR merged")).length,
      0,
    );
    const later = new BigSuperagent({
      backend: backend as never,
      agentId: "liu-big",
      home,
      loadPolicy: async () => policy,
      ask: async () => ({ ok: true, stdout: '{"kind":"ignore","reason":"x"}' }),
      gh: async () => JSON.stringify({ state: gh, url: PR }),
      now: () => Date.now() + 10 * 60_000,
    });
    await later.pass();
    await later.pass();
    const all = backend.replies(asked.header.id);
    assert.equal(all.filter((t) => t.startsWith("Done: Rename the button")).length, 1);
    assert.equal(all.filter((t) => t === `PR merged: ${PR}`).length, 1);
    assert.equal(
      all.filter((t) => t.startsWith("Question from the worker")).length,
      1,
      "the question is passed on once",
    );
  });

  it("deploys new work for a handback it can place", async () => {
    const backend = new FakeBackend();
    const asked = backend.add("superagent", "liu", "Rename the Save button", { tags: ["handled"] });
    await seedState(asked.header.id);
    backend.tasks.set(
      T1,
      taskDetail("in_progress", [
        {
          messageId: "E1",
          ts: "2026-06-01T10:00:00.000Z",
          action: "started",
          body: "Run started.",
          refs: [],
        },
      ]),
    );
    backend.add("superagent", "box-claude", "They also want the docs site rebuilt.", {
      thread: T1,
      tags: [HANDBACK_TAG],
    });
    const big = new BigSuperagent({
      backend: backend as never,
      agentId: "liu-big",
      home,
      loadPolicy: async () => policy,
      ask: async () => ({
        ok: true,
        stdout: JSON.stringify({
          kind: "accept",
          title: "Rebuild the docs site",
          room: "superagent",
          target: "machine:box",
          acknowledgement: "Starting the docs rebuild.",
          reason: "new work",
        }),
      }),
    });
    await big.pass();
    assert.equal(backend.created.length, 1);
    assert.equal(backend.created[0]?.["title"], "Rebuild the docs site");
    assert.ok(backend.replies(asked.header.id).some((t) => /Starting the docs rebuild\./.test(t)));
  });
});

describe("a decision may read tasks first", () => {
  const options = (backend: FakeBackend, ask: (prompt: string) => string) => ({
    backend: backend as never,
    worker: policy.worker,
    role: "big" as const,
    kinds: BIG_KINDS,
    self: "liu-big",
    runner: "brain",
    timeoutSeconds: 30,
    rooms: ["superagent"],
    defaultRoom: "superagent",
    now: Date.now(),
    ask: async ({ prompt }: { prompt: string }) => ({ ok: true, stdout: ask(prompt) }),
  });

  it("reads a task's history, then decides with it", async () => {
    const backend = new FakeBackend();
    backend.tasks.set(
      T1,
      taskDetail("in_progress", [
        {
          messageId: "E1",
          ts: "2026-06-01T10:00:00.000Z",
          action: "progressed",
          body: "Halfway: tests pass on macOS.",
          refs: [],
        },
      ]),
    );
    const prompts: string[] = [];
    const decided = await decide(
      { text: "How is the rename going?", author: "liu", context: [] },
      options(backend, (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? JSON.stringify({ kind: "read", taskIds: [T1], reason: "need its history" })
          : JSON.stringify({
              kind: "answer",
              text: "Halfway; tests pass on macOS.",
              reason: "from its history",
            });
      }),
    );
    assert.equal(decided.decision?.kind, "answer");
    assert.match(prompts[1] ?? "", /<<<DETAILS[\s\S]*Halfway: tests pass on macOS\./);
  });

  it("must decide after two reads", async () => {
    const backend = new FakeBackend();
    backend.tasks.set(T1, taskDetail("in_progress", []));
    const prompts: string[] = [];
    const decided = await decide(
      { text: "Status?", author: "liu", context: [] },
      options(backend, (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ kind: "read", taskIds: [T1], reason: "again" });
      }),
    );
    assert.equal(prompts.length, 3);
    const offered = /Kinds you may choose now: ([^\n.]*)/.exec(prompts[2] ?? "")?.[1] ?? "";
    assert.ok(
      offered !== "" && !offered.split(", ").includes("read"),
      "the last round is not offered read",
    );
    assert.equal(decided.decision, null);
    assert.match(decided.why ?? "", /not a decision this superagent may make/);
  });
});

/** A standing session in memory: it records each turn and answers from a script. */
class ScriptedMind implements Mind {
  readonly kind = "resume" as const;
  turns: TurnRequest[] = [];
  private rules: string | undefined;
  private readonly answers: (string | null)[];
  constructor(answers: (string | null)[]) {
    this.answers = answers;
  }
  async primed(rules: string): Promise<boolean> {
    return this.rules === rules;
  }
  async turn(request: TurnRequest) {
    this.turns.push(request);
    this.rules = request.rules;
    const answer = this.answers.shift();
    return answer === null || answer === undefined
      ? { ok: false, stdout: "", error: "timed out" }
      : { ok: true, stdout: answer };
  }
  async close(): Promise<void> {}
}

describe("a standing session decides", () => {
  const options = (backend: FakeBackend, mind: Mind) => ({
    backend: backend as never,
    worker: policy.worker,
    role: "big" as const,
    kinds: BIG_KINDS,
    self: "liu-big",
    runner: "brain",
    timeoutSeconds: 30,
    rooms: ["superagent"],
    defaultRoom: "superagent",
    now: Date.now(),
    mind,
  });

  it("is told why a reply was refused, once, in a short turn", async () => {
    const backend = new FakeBackend();
    const mind = new ScriptedMind([
      JSON.stringify({ kind: "stop", taskId: "01K0000000000000000000NOPE", reason: "x" }),
      JSON.stringify({ kind: "answer", text: "Nothing is running.", reason: "fixed" }),
    ]);
    const decided = await decide(
      { text: "Stop it", author: "liu", context: [] },
      options(backend, mind),
    );
    assert.equal(decided.decision?.kind, "answer");
    assert.equal(mind.turns.length, 2);
    assert.match(
      mind.turns[1]?.turn ?? "",
      /^--- Same message ---\nYour reply was refused: .*was not in the snapshot/,
    );
    assert.ok(
      !(mind.turns[1]?.turn ?? "").includes("<<<MESSAGE"),
      "the session already has the message",
    );
  });

  it("says the model did not answer, so the request can be tried again", async () => {
    const decided = await decide(
      { text: "Hi", author: "liu", context: [] },
      options(new FakeBackend(), new ScriptedMind([null])),
    );
    assert.equal(decided.decision, null);
    assert.equal(decided.retry, true);
  });
});

describe("the big superagent and its standing session", () => {
  it("decides once for messages that arrived together, and retries one the model did not answer", async () => {
    const backend = new FakeBackend();
    const root = backend.add("superagent", "liu", "Rename the Save button", { tags: ["to-big"] });
    backend.add("superagent", "liu", "and make it blue", {
      tags: ["to-big"],
      thread: root.header.id,
    });
    const prompts: string[] = [];
    let answer: string | null = null;
    const big = new BigSuperagent({
      backend: backend as never,
      agentId: "liu-big",
      home: await freshHome(),
      loadPolicy: async () => policy,
      ask: async ({ prompt }) => {
        prompts.push(prompt);
        return answer === null
          ? { ok: false, stdout: "", error: "timed out" }
          : { ok: true, stdout: answer };
      },
    });

    // Twice no answer: tried again, and nothing is said.
    const first = await big.pass();
    assert.deepEqual(
      first.handled.map((h) => h.decision),
      ["deferred"],
    );
    await big.pass();
    assert.equal(prompts.length, 2, "one call per pass for the whole batch");
    assert.match(
      prompts[0] ?? "",
      /Several messages arrived together[\s\S]*Rename the Save button[\s\S]*and make it blue/,
    );
    assert.equal(backend.messages.filter((m) => m.header.from === "liu-big").length, 0);

    // The third time it answers.
    answer = JSON.stringify({ kind: "answer", text: "Nothing is deployed yet.", reason: "ok" });
    const third = await big.pass();
    assert.deepEqual(
      third.handled.map((h) => h.decision),
      ["answer"],
    );
    const replies = backend.messages.filter((m) => m.header.from === "liu-big");
    assert.equal(replies.length, 1);
    assert.equal(
      replies[0]?.header.inReplyTo,
      backend.messages[1]?.header.id,
      "under the newest message",
    );
    assert.deepEqual((await big.pass()).handled, [], "handled once");
  });

  it("gives up after three passes with no answer, and says so once", async () => {
    const backend = new FakeBackend();
    backend.add("superagent", "liu", "Hello?", { tags: ["to-big"] });
    const big = new BigSuperagent({
      backend: backend as never,
      agentId: "liu-big",
      home: await freshHome(),
      loadPolicy: async () => policy,
      ask: async () => ({ ok: false, stdout: "", error: "timed out" }),
    });
    const kinds = [];
    for (let i = 0; i < 4; i += 1) kinds.push(...(await big.pass()).handled.map((h) => h.decision));
    assert.deepEqual(kinds, ["deferred", "deferred", "undecided"]);
    const said = backend.messages.filter((m) => m.header.from === "liu-big").map((m) => m.body);
    assert.equal(said.length, 1);
    assert.match(said[0] ?? "", /could not decide/);
  });
});

/** A home whose superagent started before the fake backend's messages. */
async function freshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oguri-big-session-"));
  await mkdir(join(dir, "superagent"), { recursive: true });
  await writeFile(
    join(dir, "superagent", "big.json"),
    JSON.stringify({ handled: [], since: "2026-01-01T00:00:00.000Z", tracked: {}, noted: {} }),
  );
  return dir;
}
