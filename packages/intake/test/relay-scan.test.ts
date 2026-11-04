import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, beforeEach, describe, it } from "node:test";

import { Layout, type TaskDetail } from "@oguri/core";
import { openBackend } from "@oguri/daemon";
import type { Message } from "@oguri/protocol";

import type { OutboundReply, Outbox } from "../src/outbox/types.ts";
import {
  AUTO_GRACE_MS,
  RELAY_CURSOR_FILE,
  RESCAN_LOOKBACK_MS,
  readCursor,
  roomReplies,
  scanRelays,
} from "../src/relay-scan.ts";
import { relayBackend } from "../src/relay-pipeline.ts";
import { ORIGIN, ROOM, TaskThread, Timeline } from "./room-fixture.ts";

/**
 * Finding the replies a room owes the chat (ADR 0030 §6, §7): relay messages,
 * automatic results and questions, and the per-room cursor that keeps a scan
 * cheap. The last case runs against a real bare transport repository.
 */

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "cli", "dist", "bin.js");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

/** An outbox that remembers what it was given, deduplicated by key like the real one. */
class MemoryOutbox implements Outbox {
  readonly replies = new Map<string, OutboundReply>();
  async enqueue(reply: OutboundReply): Promise<void> {
    if (!this.replies.has(reply.key)) this.replies.set(reply.key, reply);
  }
  async flush(): Promise<void> {}
  get keys(): string[] {
    return [...this.replies.keys()];
  }
}

const dirs: string[] = [];
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "oguri-intake-scan-"));
  dirs.push(stateDir);
});

after(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** A backend over fixed rooms, counting reads. */
function rooms(byRoom: Record<string, Message[]>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (room: string): Promise<Message[]> => {
      reads.push(room);
      const messages = byRoom[room];
      if (messages === undefined) throw new Error(`not subscribed to ${room}`);
      return messages;
    },
  };
}

const LATER = 10 * AUTO_GRACE_MS;

describe("roomReplies", () => {
  it("sends a completion as the result when the agent wrote none, once", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    const done = thread.event("completed", {
      body: "Done by worker (runner claude, 2m).\n\nFixed the button.\n\nFull log: bob:/runs/x",
      refs: ["https://github.com/acme/app/pull/7"],
    });
    const replies = roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + LATER });
    assert.deepEqual(replies, [
      {
        key: `auto-result:${thread.task.id}:${done.header.id}`,
        source: "feishu",
        conversation: ORIGIN.conversation,
        replyTo: ORIGIN.message,
        text: "Done by worker (runner claude, 2m). Fixed the button. https://github.com/acme/app/pull/7",
        purpose: "result",
        taskId: thread.task.id,
      },
    ]);
  });

  it("cuts an automatic result to 100 words, below a larger limit", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("completed", { body: Array.from({ length: 300 }, () => "w").join(" ") });
    const [reply] = roomReplies(thread.messages, 0, { maxReplyWords: 300, now: time.at + LATER });
    assert.equal(reply?.text, `${Array.from({ length: 100 }, () => "w").join(" ")}…`);
  });

  it("stays quiet when the agent sent its own result, before or after the event", () => {
    const time = new Timeline();
    const before = new TaskThread(time).run();
    const own = before.say("Fixed it.", { relay: "result" });
    before.event("completed", { body: "Done." });
    assert.deepEqual(
      roomReplies(before.messages, 0, { maxReplyWords: 100, now: time.at + LATER }).map(
        (reply) => reply.key,
      ),
      [`relay:${own.header.id}`],
    );

    const afterwards = new TaskThread(time).run();
    afterwards.event("completed", { body: "Done." });
    const late = afterwards.say("Fixed it.", { relay: "result" });
    assert.deepEqual(
      roomReplies(afterwards.messages, 0, { maxReplyWords: 100, now: time.at + LATER }).map(
        (reply) => reply.key,
      ),
      [`relay:${late.header.id}`],
    );
  });

  it("waits a grace period for the agent's own relay before speaking", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("completed", { body: "Done." });
    assert.deepEqual(roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at }), []);
    assert.equal(
      roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + AUTO_GRACE_MS }).length,
      1,
    );
  });

  it("asks the chat when a task blocks for a person, and not for an ordinary block", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    const blocked = thread.event("blocked", {
      body: "It needs a person before it can finish.\n\nQuestion: Which account should I use?",
      needs: "human",
    });
    const [reply] = roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + LATER });
    assert.equal(reply?.key, `auto-attention:${thread.task.id}:${blocked.header.id}`);
    assert.equal(reply?.purpose, "attention");
    assert.match(reply?.text ?? "", /Which account should I use\?$/);

    // The agent asked through its own relay: no second question.
    const asked = new TaskThread(time).run();
    asked.say("Which account?", { relay: "attention" });
    asked.event("blocked", { body: "Blocked.", needs: "human" });
    assert.deepEqual(
      roomReplies(asked.messages, 0, { maxReplyWords: 100, now: time.at + LATER }).map(
        (r) => r.purpose,
      ),
      ["attention"],
    );
    assert.equal(
      roomReplies(asked.messages, 0, {
        maxReplyWords: 100,
        now: time.at + LATER,
      })[0]?.key.startsWith("relay:"),
      true,
    );

    const ordinary = new TaskThread(time).run();
    ordinary.event("blocked", { body: "Waiting on CI." });
    assert.deepEqual(
      roomReplies(ordinary.messages, 0, { maxReplyWords: 100, now: time.at + LATER }),
      [],
    );
  });

  it("asks again after a second block, not again for the same one", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("blocked", { body: "First question?", needs: "human" });
    const first = roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + LATER });
    thread.event("started");
    thread.event("blocked", { body: "Second question?", needs: "human" });
    const second = roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + LATER });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0]?.key, second[0]?.key);
  });

  it("leaves tasks without an origin alone", () => {
    const time = new Timeline();
    const thread = new TaskThread(time, { origin: null }).run();
    thread.say("Done.", { relay: "result" });
    thread.event("completed", { body: "Done." });
    assert.deepEqual(
      roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + LATER }),
      [],
    );
  });

  it("does not speak for intake's own completion after a merge", () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    const url = "https://github.com/acme/app/pull/7";
    thread.event("completed", { body: `PR merged: ${url}`, refs: [url], from: "bob-worker" });
    assert.deepEqual(
      roomReplies(thread.messages, 0, { maxReplyWords: 100, now: time.at + LATER }),
      [],
    );
  });
});

describe("scanRelays", () => {
  it("enqueues each reply once, and keeps a cursor per room", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    const ack = thread.say("On it.", { relay: "ack" });
    const backend = rooms({ [ROOM]: thread.messages, quiet: [] });
    const outbox = new MemoryOutbox();
    const options = { outbox, stateDir, maxReplyWords: 100, now: () => time.at + LATER };

    await scanRelays(backend, [ROOM, "quiet"], 0, options);
    assert.deepEqual(outbox.keys, [`relay:${ack.header.id}`]);
    const cursor = await readCursor(stateDir);
    assert.equal(cursor.rooms[ROOM]?.last, ack.header.id);
    assert.equal(cursor.rooms[ROOM]?.floor, 0);
    assert.equal(cursor.rooms["quiet"]?.last, undefined);

    // A restart reads the cursor back; nothing is enqueued twice.
    const done = thread.event("completed", { body: "Fixed." });
    const report = await scanRelays(backend, [ROOM, "quiet"], 0, options);
    assert.deepEqual(outbox.keys, [
      `relay:${ack.header.id}`,
      `auto-result:${thread.task.id}:${done.header.id}`,
    ]);
    assert.equal(report.replies.length, 2, "the overlap re-finds the ack; the outbox dedupes it");
    assert.equal((await readCursor(stateDir)).rooms[ROOM]?.last, done.header.id);
    const onDisk = JSON.parse(await readFile(join(stateDir, RELAY_CURSOR_FILE), "utf8")) as {
      rooms: Record<string, { last?: string }>;
    };
    assert.equal(onDisk.rooms[ROOM]?.last, done.header.id);
  });

  it("starts a new room at `since`, and rescans behind the mark for late pushes", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    const old = thread.say("Old ack.", { relay: "ack" });
    const since = time.tick();
    const fresh = thread.say("New answer.", { relay: "answer" });
    const outbox = new MemoryOutbox();
    const options = { outbox, stateDir, maxReplyWords: 100, now: () => time.at + LATER };
    await scanRelays(rooms({ [ROOM]: thread.messages }), [ROOM], since, options);
    assert.deepEqual(outbox.keys, [`relay:${fresh.header.id}`], "history is not replayed");

    // Written on another machine before the mark, but pushed after the scan that set it.
    const late = thread.say("Late answer.", { relay: "answer" });
    const pushedLate = thread.messages.pop() as Message;
    time.tick(2 * 60 * 60_000);
    const mark = thread.say("Mark.");
    await scanRelays(rooms({ [ROOM]: thread.messages }), [ROOM], since, options);
    assert.equal((await readCursor(stateDir)).rooms[ROOM]?.last, mark.header.id);
    thread.messages.push(pushedLate);
    await scanRelays(rooms({ [ROOM]: thread.messages }), [ROOM], since, options);
    assert.deepEqual(outbox.keys, [`relay:${fresh.header.id}`, `relay:${late.header.id}`]);
    assert.equal(outbox.keys.includes(`relay:${old.header.id}`), false);

    // Beyond the lookback, a late push is no longer looked for.
    const tooLate = thread.say("Too late.", { relay: "answer" });
    const lost = thread.messages.pop() as Message;
    time.tick(RESCAN_LOOKBACK_MS + 60_000);
    thread.say("Next mark.");
    await scanRelays(rooms({ [ROOM]: thread.messages }), [ROOM], since, options);
    thread.messages.push(lost);
    await scanRelays(rooms({ [ROOM]: thread.messages }), [ROOM], since, options);
    assert.equal(outbox.keys.includes(`relay:${tooLate.header.id}`), false);
  });

  it("reports a room it cannot read and still scans the others", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.say("On it.", { relay: "ack" });
    const outbox = new MemoryOutbox();
    const report = await scanRelays(rooms({ [ROOM]: thread.messages }), ["gone", ROOM], 0, {
      outbox,
      stateDir,
      maxReplyWords: 100,
      now: () => time.at,
    });
    assert.deepEqual(report.failed, [{ room: "gone", error: "not subscribed to gone" }]);
    assert.equal(outbox.keys.length, 1);
  });
});

describe("scanRelays over a real transport repository", () => {
  it("finds a worker's relay and its completion through the backend", async () => {
    await access(CLI).catch(() => {
      throw new Error(`${CLI} is missing — run 'pnpm build' before 'pnpm test'`);
    });
    const tmp = await mkdtemp(join(tmpdir(), "oguri-intake-repo-"));
    dirs.push(tmp);
    const remote = join(tmp, "transport.git");
    const intakeHome = join(tmp, "intake");
    const workerHome = join(tmp, "worker");
    const oguri = async (home: string, ...args: string[]) =>
      await exec(process.execPath, [CLI, ...args, "--direct"], {
        env: { ...process.env, OGURI_HOME: home, NO_COLOR: "1" },
      });
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    await oguri(intakeHome, "init", "--repo", remote, "--network", "acme", "--agent", "intake-bot");
    await oguri(intakeHome, "room", "create", ROOM);
    await oguri(workerHome, "init", "--repo", remote, "--agent", "bob-worker");
    await oguri(workerHome, "room", "join", ROOM);
    // The worker's machine takes work from intake without asking, as a worker host would.
    await writeFile(
      join(workerHome, "policy.yaml"),
      "v: 1\napprovals:\n  localAgents: [intake-bot]\n",
      "utf8",
    );

    const since = Date.now() - 1_000;
    const intake = await openBackend({ layout: new Layout(intakeHome), forceDirect: true });
    let taskId: string;
    try {
      const created = await intake.call<Message>("taskCreate", {
        room: ROOM,
        input: {
          title: "Fix the login button",
          definition: "Please fix the login button.",
          target: "bob-worker",
          origin: ORIGIN,
        },
      });
      taskId = created.header.task?.id as string;
    } finally {
      await intake.close();
    }

    const worker = await openBackend({ layout: new Layout(workerHome), forceDirect: true });
    let ackId: string;
    try {
      await worker.call("sync");
      await worker.call("taskClaim", { room: ROOM, taskId, body: "Claimed." });
      await worker.call("taskUpdate", {
        room: ROOM,
        taskId,
        input: { action: "started", body: "Started." },
      });
      const detail = await worker.call<TaskDetail>("taskShow", { room: ROOM, taskId });
      const ack = await worker.call<Message>("send", {
        room: ROOM,
        input: {
          body: "On it: fixing the login button.",
          needs: "none",
          relay: "ack",
          inReplyTo: detail.rootMessageId,
        },
      });
      ackId = ack.header.id;
      await worker.call("taskUpdate", {
        room: ROOM,
        taskId,
        input: { action: "completed", body: "Fixed the button." },
      });
    } finally {
      await worker.close();
    }

    const reader = await openBackend({ layout: new Layout(intakeHome), forceDirect: true });
    const outbox = new MemoryOutbox();
    try {
      await scanRelays(relayBackend(reader), [ROOM], since, {
        outbox,
        stateDir,
        maxReplyWords: 100,
        now: () => Date.now() + LATER,
      });
    } finally {
      await reader.close();
    }
    const replies = [...outbox.replies.values()];
    assert.deepEqual(
      replies.map((reply) => [reply.purpose, reply.text, reply.replyTo]),
      [
        ["ack", "On it: fixing the login button.", ORIGIN.message],
        ["result", "Fixed the button.", ORIGIN.message],
      ],
    );
    assert.equal(replies[0]?.key, `relay:${ackId}`);
    assert.equal(replies[1]?.taskId, taskId);
    assert.ok((await readCursor(stateDir)).rooms[ROOM]?.last !== undefined);
  });
});
