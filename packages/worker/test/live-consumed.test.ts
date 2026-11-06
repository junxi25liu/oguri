/**
 * A message written to a live session is consumed only if the session read it.
 *
 * The fake executor stands in for a live `claude`: it hands the worker a write
 * function, counts what is written, and ends the run after echoing only some of
 * it, as a session killed by a timeout or a cancel would.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { Message } from "@oguri/protocol";

import { fakeBackend, policy as basePolicy, result, threadMessage } from "./fake-backend.ts";
import type { Executor } from "../src/runner.ts";
import { pendingMessages } from "../src/followup.ts";
import { readConsumed } from "../src/runs.ts";
import { Worker } from "../src/worker.ts";

const ME = "bob-claude";
const ID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-live-consumed-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

describe("a live session's messages", () => {
  it("are consumed when the session echoed them, and not otherwise", async () => {
    const messages: Message[] = [];
    const written: string[] = [];
    let first: Message | undefined;
    let second: Message | undefined;

    // Writes: the prompt (1), then one message per delivery. Only the first
    // message is echoed before the run ends, so messagesRead is 2.
    const executor: Executor = async (request) => {
      request.live?.bind((text) => {
        written.push(text);
        return true;
      });
      written.push(request.prompt);
      await sleep(20);
      first = threadMessage(ID_A, "First follow-up", { external: {} });
      messages.push(first);
      await until(() => written.length === 2);
      await sleep(20);
      second = threadMessage(ID_A, "Second follow-up", { external: {} });
      messages.push(second);
      await until(() => written.length === 3);
      return result({ exitCode: null, signal: "SIGTERM", timedOut: true, messagesRead: 2 });
    };

    const { backend } = fakeBackend(
      [{ id: ID_A, state: "open", creator: "alice-claude", definition: "Fix it." }],
      { messages },
    );
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      liveIntervalMs: 20,
      loadPolicy: async () =>
        basePolicy({
          runners: {
            claude: {
              argv: ["claude", "-p", "--input-format", "stream-json"],
              session: "claude-stream",
              worktree: false,
            },
          },
        }),
      executor,
    });

    await worker.pass();
    await worker.idle();

    assert.match(written[1] ?? "", /First follow-up/);
    assert.match(written[2] ?? "", /Second follow-up/);
    assert.ok(first !== undefined && second !== undefined);

    const consumed = await readConsumed(home, ID_A);
    assert.equal(consumed.has(first.header.id), true, "echoed, so answered");
    assert.equal(consumed.has(second.header.id), false, "written but never echoed");

    const pending = pendingMessages(messages, {
      thread: ID_A,
      agentId: ME,
      since: new Date(0).toISOString(),
      consumed,
    });
    assert.deepEqual(
      pending.map((message) => message.header.id),
      [second.header.id],
      "the unread one is still a follow-up for the next pass",
    );
  });

  it("are all consumed when the session read every write", async () => {
    const messages: Message[] = [];
    const written: string[] = [];
    let first: Message | undefined;
    const executor: Executor = async (request) => {
      request.live?.bind((text) => {
        written.push(text);
        return true;
      });
      written.push(request.prompt);
      await sleep(20);
      first = threadMessage(ID_A, "Only follow-up", { external: {} });
      messages.push(first);
      await until(() => written.length === 2);
      return result({ messagesRead: 2 });
    };
    const { backend } = fakeBackend(
      [{ id: ID_A, state: "open", creator: "alice-claude", definition: "Fix it." }],
      { messages },
    );
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      liveIntervalMs: 20,
      loadPolicy: async () =>
        basePolicy({
          runners: {
            claude: { argv: ["claude", "-p"], session: "claude-stream", worktree: false },
          },
        }),
      executor,
    });

    await worker.pass();
    await worker.idle();

    assert.ok(first !== undefined);
    assert.equal((await readConsumed(home, ID_A)).has(first.header.id), true);
  });
});
