import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { DEFAULT_INTAKE_POLICY, type IntakePolicy } from "@oguri/core";
import type { Message } from "@oguri/protocol";

import {
  GH_TIMEOUT_MS,
  MAX_COMPLETE_ATTEMPTS,
  PRS_FILE,
  PR_CHECK_INTERVAL_MS,
  isPrUrl,
  parsePrView,
  prUrlsIn,
  readPrState,
  type GhRunner,
  type PrState,
} from "../src/github/pr-follow.ts";
import { FileOutbox } from "../src/outbox/file-outbox.ts";
import type { ReplySender } from "../src/outbox/sender.ts";
import type { OutboundReply } from "../src/outbox/types.ts";
import { AUTO_GRACE_MS } from "../src/relay-scan.ts";
import { RelayPipeline } from "../src/relay-pipeline.ts";
import { ORIGIN, ROOM, TaskThread, Timeline, WORKER } from "./room-fixture.ts";

/**
 * Following the pull request a chat-origin task reports (ADR 0030 §8), and the
 * pipeline intake's loop calls once per poll. `gh` is a fake runner.
 */

const PR = "https://github.com/acme/app/pull/7";

const dirs: string[] = [];
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "oguri-intake-pr-"));
  dirs.push(stateDir);
});

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A fake `gh pr view`: answers from a map, records every argv. */
function fakeGh(states: Record<string, PrState>) {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
  const run: GhRunner = async (argv, options) => {
    calls.push({ argv, timeoutMs: options.timeoutMs });
    const url = argv[3] as string;
    const state = states[url];
    if (state === undefined) throw new Error("gh: no pull request found");
    return JSON.stringify({
      state,
      url,
      mergedAt: state === "MERGED" ? "2026-11-03T12:00:00Z" : null,
      closedAt: state === "OPEN" ? null : "2026-11-03T12:00:00Z",
    });
  };
  return { calls, run };
}

/** Everything sent, by the outbox, through a sender that always succeeds. */
function memorySender() {
  const sent: OutboundReply[] = [];
  const sender: ReplySender = {
    send: async (reply) => {
      sent.push(reply);
      return {};
    },
  };
  return { sent, sender };
}

interface Setup {
  pipeline: RelayPipeline;
  sent: OutboundReply[];
  gh: ReturnType<typeof fakeGh>;
  completions: { room: string; taskId: string; body: string; refs: string[] }[];
  time: Timeline;
  clock: { now: number };
  outbox: FileOutbox;
}

function setup(
  thread: TaskThread,
  time: Timeline,
  options: {
    states: Record<string, PrState>;
    policy?: IntakePolicy;
    /** Complete as the assignee (true), or be refused like a non-assignee (false). */
    canComplete?: boolean;
  },
): Setup {
  const clock = { now: time.at };
  const { sent, sender } = memorySender();
  const outbox = new FileOutbox({ stateDir, senders: { feishu: sender }, now: () => clock.now });
  const gh = fakeGh(options.states);
  const completions: Setup["completions"] = [];
  const pipeline = new RelayPipeline({
    backend: {
      read: async () => [...thread.messages],
      completeTask: async (room, taskId, body, refs) => {
        completions.push({ room, taskId, body, refs });
        if (options.canComplete === false) {
          throw new Error(`only assignee ${WORKER} may mark a task 'completed'`);
        }
        return thread.event("completed", { body, refs });
      },
    },
    rooms: () => [ROOM],
    outbox,
    policy: () => options.policy ?? { ...DEFAULT_INTAKE_POLICY, githubCli: "gh" },
    stateDir,
    since: 0,
    now: () => clock.now,
    runGh: gh.run,
  });
  return { pipeline, sent, gh, completions, time, clock, outbox };
}

describe("pull request URLs", () => {
  it("accepts a GitHub PR URL and nothing near it", () => {
    assert.deepEqual(
      prUrlsIn([
        PR,
        `${PR}/files`,
        `${PR}#discussion_r1`,
        "https://github.com/acme/app/pull/77",
        "https://github.com/acme/app/pull/7x",
        "http://github.com/acme/app/pull/8",
        "https://github.com.evil.test/acme/app/pull/9",
        "https://github.com/acme/app/issues/10",
        "artifact:bob:/out/report.txt",
        "https://github.com/-acme/app/pull/11",
      ]),
      [PR, "https://github.com/acme/app/pull/77"],
    );
    assert.equal(isPrUrl(PR), true);
    assert.equal(isPrUrl(`${PR} --web`), false);
  });

  it("reads gh's JSON and refuses an unknown state", () => {
    assert.deepEqual(parsePrView('{"state":"MERGED","mergedAt":"t","closedAt":"t","url":"u"}'), {
      state: "MERGED",
      mergedAt: "t",
      closedAt: "t",
      url: "u",
    });
    assert.deepEqual(parsePrView('{"state":"OPEN","mergedAt":null,"closedAt":null}'), {
      state: "OPEN",
    });
    assert.throws(() => parsePrView('{"state":"DRAFT"}'), /unexpected state/);
  });
});

describe("PR follow through the pipeline", () => {
  it("on merge, replies once and completes the task once", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("progressed", { body: "Opened a PR; waiting for review.", refs: [PR] });
    const s = setup(thread, time, { states: { [PR]: "MERGED" } });

    await s.pipeline.tick();
    assert.deepEqual(s.gh.calls, [
      {
        argv: ["gh", "pr", "view", PR, "--json", "state,mergedAt,closedAt,url"],
        timeoutMs: GH_TIMEOUT_MS,
      },
    ]);
    assert.deepEqual(s.completions, [
      { room: ROOM, taskId: thread.task.id, body: `PR merged: ${PR}`, refs: [PR] },
    ]);
    assert.equal(thread.task.state, "completed");
    assert.deepEqual(
      s.sent.map((reply) => [reply.key, reply.text, reply.replyTo, reply.purpose]),
      [[`pr-merged:${PR}`, `PR merged: ${PR}`, ORIGIN.message, "result"]],
    );

    // Later ticks: no second note, no automatic result for intake's own completion, no more gh.
    for (let i = 0; i < 3; i++) {
      s.clock.now += Math.max(PR_CHECK_INTERVAL_MS, AUTO_GRACE_MS) + 1;
      await s.pipeline.tick();
    }
    assert.equal(s.gh.calls.length, 1);
    assert.equal(s.completions.length, 1);
    assert.equal(s.sent.length, 1);

    const saved = await readPrState(stateDir);
    assert.equal(saved.prs[PR]?.state, "MERGED");
    assert.equal(saved.prs[PR]?.settled, true);
    assert.equal(saved.prs[PR]?.completion?.outcome, "completed");
  });

  it("on merge of a completed task, replies and leaves the task alone", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.say("Fixed; PR is up.", { relay: "result" });
    thread.event("completed", { body: "Done.", refs: [PR] });
    const s = setup(thread, time, { states: { [PR]: "MERGED" } });
    s.clock.now += AUTO_GRACE_MS + 1;

    await s.pipeline.tick();
    assert.deepEqual(s.completions, []);
    assert.deepEqual(
      s.sent.map((reply) => reply.key.split(":")[0]),
      ["relay", "pr-merged"],
      "the agent's result, then one closing note",
    );
    assert.equal((await readPrState(stateDir)).prs[PR]?.completion?.outcome, "already-done");
  });

  it("checks an open PR at most once a minute, and remembers across a restart", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("progressed", { body: "PR is up.", refs: [PR] });
    const states: Record<string, PrState> = { [PR]: "OPEN" };
    const s = setup(thread, time, { states });

    await s.pipeline.tick();
    s.clock.now += PR_CHECK_INTERVAL_MS - 1;
    await s.pipeline.tick();
    assert.equal(s.gh.calls.length, 1);

    // A restarted intake reads prs.json back and keeps to the same rhythm.
    const restarted = setup(thread, time, { states });
    restarted.clock.now = s.clock.now;
    await restarted.pipeline.tick();
    assert.equal(restarted.gh.calls.length, 0);
    restarted.clock.now += 1;
    states[PR] = "CLOSED";
    await restarted.pipeline.tick();
    assert.equal(restarted.gh.calls.length, 1);
    assert.deepEqual(
      restarted.sent.map((reply) => [reply.key, reply.text]),
      [[`pr-closed:${PR}`, `PR closed without merging: ${PR}`]],
    );
    assert.deepEqual(restarted.completions, [], "a closed PR does not complete the task");
    const saved = JSON.parse(await readFile(join(stateDir, PRS_FILE), "utf8")) as {
      prs: Record<string, { state: string; settled?: boolean }>;
    };
    assert.deepEqual([saved.prs[PR]?.state, saved.prs[PR]?.settled], ["CLOSED", true]);
  });

  it("records a refused completion, retries it a few times, and still replies once", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("progressed", { body: "PR is up.", refs: [PR] });
    const s = setup(thread, time, { states: { [PR]: "MERGED" }, canComplete: false });

    for (let i = 0; i < MAX_COMPLETE_ATTEMPTS + 2; i++) {
      await s.pipeline.tick();
      s.clock.now += PR_CHECK_INTERVAL_MS;
    }
    assert.equal(s.completions.length, MAX_COMPLETE_ATTEMPTS);
    assert.equal(s.sent.length, 1);
    const pr = (await readPrState(stateDir)).prs[PR];
    assert.equal(pr?.settled, true);
    assert.equal(pr?.completion?.outcome, "refused");
    assert.match(pr?.completion?.detail ?? "", /only assignee/);
  });

  it("keeps a gh failure on record and tries again later", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("progressed", { body: "PR is up.", refs: [PR] });
    const s = setup(thread, time, { states: {} });
    const report = await s.pipeline.tick();
    assert.match(report.prs?.failed[0]?.error ?? "", /no pull request found/);
    assert.match((await readPrState(stateDir)).prs[PR]?.error ?? "", /no pull request found/);
    s.clock.now += PR_CHECK_INTERVAL_MS;
    await s.pipeline.tick();
    assert.equal(s.gh.calls.length, 2);
  });

  it("does nothing with PRs when githubCli is unset", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.event("progressed", { body: "PR is up.", refs: [PR] });
    // The default policy is what a section without `githubCli` parses to.
    const s = setup(thread, time, { states: { [PR]: "MERGED" }, policy: DEFAULT_INTAKE_POLICY });
    const report = await s.pipeline.tick();
    assert.equal(report.prs, null);
    assert.equal(s.gh.calls.length, 0);
    assert.deepEqual(s.completions, []);
    assert.equal((await readPrState(stateDir)).prs[PR], undefined);
  });

  it("ignores PRs on tasks with no origin", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time, { origin: null }).run();
    thread.event("progressed", { body: "PR is up.", refs: [PR] });
    const s = setup(thread, time, { states: { [PR]: "MERGED" } });
    await s.pipeline.tick();
    assert.equal(s.gh.calls.length, 0);
  });
});

describe("RelayPipeline", () => {
  it("scans, then flushes in the same tick, and keeps going when a room fails", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.say("On it.", { relay: "ack" });
    const clock = { now: time.at };
    const { sent, sender } = memorySender();
    const pipeline = new RelayPipeline({
      backend: {
        read: async (room) => {
          if (room !== ROOM) throw new Error(`cannot read ${room}`);
          return thread.messages;
        },
        completeTask: async () => ({}) as Message,
      },
      rooms: () => ["broken", ROOM, ROOM],
      outbox: new FileOutbox({ stateDir, senders: { feishu: sender }, now: () => clock.now }),
      policy: () => DEFAULT_INTAKE_POLICY,
      stateDir,
      since: 0,
      now: () => clock.now,
    });
    const report = await pipeline.tick();
    assert.deepEqual(
      sent.map((reply) => reply.text),
      ["On it."],
    );
    assert.deepEqual(report.scan.failed, [{ room: "broken", error: "cannot read broken" }]);
    assert.deepEqual(report.errors, []);

    await pipeline.tick();
    assert.equal(sent.length, 1);
  });

  it("does not flush once the signal has aborted", async () => {
    const time = new Timeline();
    const thread = new TaskThread(time).run();
    thread.say("On it.", { relay: "ack" });
    const { sent, sender } = memorySender();
    const outbox = new FileOutbox({ stateDir, senders: { feishu: sender } });
    const pipeline = new RelayPipeline({
      backend: { read: async () => thread.messages, completeTask: async () => ({}) as Message },
      rooms: () => [ROOM],
      outbox,
      policy: () => DEFAULT_INTAKE_POLICY,
      stateDir,
      since: 0,
    });
    const controller = new AbortController();
    controller.abort();
    await pipeline.tick(controller.signal);
    assert.equal(sent.length, 0);
    assert.equal((await outbox.status()).queued, 1, "found and queued, sent next tick");
  });
});
