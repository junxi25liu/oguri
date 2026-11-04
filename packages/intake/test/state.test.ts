import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TaskStatus } from "@oguri/core";
import type { Message } from "@oguri/protocol";

import { TITLE_LIMIT, followupMessage, taskTitle } from "../src/request.ts";
import {
  DEDUPE_WINDOW_MS,
  emptyState,
  findTask,
  intakeDir,
  readIntakeState,
  rebuildTaskMap,
  relayedKeys,
  writeIntakeState,
} from "../src/state.ts";
import type { InboundMessage } from "../src/source.ts";

/** Intake's cache and the pure pieces that shape what it writes. */

function status(
  id: string,
  root: string,
  origin?: { message: string; thread?: string },
): TaskStatus {
  return {
    task: {
      id,
      title: id,
      creator: "intake-bot",
      state: "open",
      action: "created",
      ...(origin === undefined
        ? {}
        : { origin: { source: "feishu", conversation: "oc", requester: "ou_a", ...origin } }),
    },
    rootMessageId: root,
    thread: root,
  } as unknown as TaskStatus;
}

describe("intake state", () => {
  it("round-trips atomically and treats a broken file as a fresh start", async () => {
    const home = await mkdtemp(join(tmpdir(), "oguri-intake-state-"));
    try {
      const state = emptyState();
      state.botId = "ou_bot";
      state.cursors["oc"] = { ms: 5, ids: ["om_1"] };
      await writeIntakeState(home, state);
      assert.deepEqual(await readIntakeState(home), state);
      await writeFile(join(intakeDir(home), "state.json"), "{not json");
      assert.deepEqual(await readIntakeState(home), emptyState());
      assert.match(await readFile(join(intakeDir(home), "state.json"), "utf8"), /not json/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds the task map from tasks with a Feishu origin; the first task keeps a shared thread", () => {
    const map = rebuildTaskMap(
      [
        {
          room: "ops",
          tasks: [
            status("T2", "01B", { message: "om_2", thread: "om_root" }),
            status("T1", "01A", { message: "om_1", thread: "om_root" }),
            status("T3", "01C"),
          ],
        },
      ],
      "acme",
    );
    assert.equal(map["om_1"]?.taskId, "T1");
    assert.equal(map["om_2"]?.taskId, "T2");
    assert.equal(map["om_root"]?.taskId, "T1");
    assert.equal(Object.keys(map).length, 3, "a task with no origin is not intake's");
    // A reply to the second request reaches the second task, not the thread's first.
    assert.equal(findTask(map, ["om_2", undefined, "om_root"])?.taskId, "T2");
    assert.equal(findTask(map, ["om_x", undefined, "om_root"])?.taskId, "T1");
  });

  it("collects dedupe keys from external headers and task origins inside the window", () => {
    const now = Date.parse("2026-11-03T00:00:00Z");
    const at = (ms: number) => new Date(ms).toISOString();
    const messages = [
      { header: { ts: at(now - 1000), external: { source: "feishu", id: "om_a" } } },
      { header: { ts: at(now - 1000), task: { origin: { source: "feishu", message: "om_b" } } } },
      {
        header: {
          ts: at(now - DEDUPE_WINDOW_MS - 1),
          external: { source: "feishu", id: "om_old" },
        },
      },
    ] as unknown as Message[];
    assert.deepEqual([...relayedKeys(messages, now)].sort(), ["feishu:om_a", "feishu:om_b"]);
  });
});

describe("intake request shaping", () => {
  it("titles a task with its first non-empty line, cut to the protocol limit", () => {
    assert.equal(taskTitle("\n  Fix   the button \nmore"), "Fix the button");
    const long = taskTitle("x".repeat(500));
    assert.equal(long.length, TITLE_LIMIT);
    assert.ok(long.endsWith("…"));
  });

  it("addresses a follow-up to the task's holder, else its target, else the room", () => {
    const message = {
      external: { source: "feishu", id: "om_1", actor: "ou_a", human: true },
      text: "more",
      addressed: null,
      at: "",
    } satisfies InboundMessage;
    const held = { task: { assignee: "bob-claude", target: "machine:x" } } as unknown as TaskStatus;
    const aimed = { task: { target: "machine:x" } } as unknown as TaskStatus;
    assert.deepEqual(followupMessage(message, "R", held, true).mentions, ["bob-claude"]);
    assert.deepEqual(followupMessage(message, "R", aimed, true).mentions, ["machine:x"]);
    assert.deepEqual(followupMessage(message, "R", undefined, true).mentions, ["@room"]);
  });
});
