/**
 * The order a worker claims in (ADR 0035), against a real reduction and a real
 * agenda rather than a hand-shaped list of entries.
 *
 * The agenda sorts by attention first and then by the oldest `updatedAt`, which
 * is the right order for "what needs me" and the wrong one for "what do I take
 * next": every event moves a task's `updatedAt`, so a task that was released
 * after a failed run drops to the back however early it was created. The worker
 * reads `priority` and the task id instead, and both survive that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgenda, reduceTasks } from "@oguri/core";
import { createMessage, createTask, type Message, type Task } from "@oguri/protocol";

import { selectCandidates } from "../src/select.ts";
import { policy } from "./fake-backend.ts";

const OLD = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const NEW = "01JBBBBBBBBBBBBBBBBBBBBBBB";
const ME = "bob-claude";

function event(task: Task, options: { inReplyTo?: string; thread?: string; ts: string }): Message {
  return createMessage({
    id: task.id,
    room: "ops",
    from: task.state === "open" && task.action !== "released" ? "alice-claude" : ME,
    authorKind: "agent",
    kind: task.action === "created" ? "question" : "status",
    needs: task.state === "open" ? "agent" : "none",
    mentions: task.action === "created" ? [task.target ?? "@room"] : [],
    thread: options.thread ?? task.id,
    ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
    ts: options.ts,
    body: `${task.action}\n`,
    task,
  });
}

/**
 * An old task that was claimed and released after a failed run, and a newer
 * task nobody has touched. Both are open, offered to this machine, and ready.
 */
function rooms(now: number) {
  const older = createTask({
    id: OLD,
    creator: "alice-claude",
    title: "Old, released after a failed run",
    target: `machine:build-01`,
  });
  const created = event(older, { ts: "2026-11-05T10:00:00.000Z" });
  const claimed: Task = {
    ...older,
    action: "claimed",
    state: "claimed",
    assignee: ME,
    assigneeMachine: "build-01",
  };
  const claim = event(claimed, {
    inReplyTo: created.header.id,
    thread: created.header.thread,
    ts: "2026-11-05T10:02:00.000Z",
  });
  const started: Task = { ...claimed, action: "started", state: "in_progress" };
  const start = event(started, {
    inReplyTo: claim.header.id,
    thread: created.header.thread,
    ts: "2026-11-05T10:03:00.000Z",
  });
  const released: Task = { ...older, action: "released", state: "open" };
  const release = createMessage({
    id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
    room: "ops",
    from: ME,
    authorKind: "agent",
    kind: "status",
    needs: "agent",
    mentions: ["machine:build-01"],
    thread: created.header.thread,
    inReplyTo: start.header.id,
    ts: "2026-11-05T10:10:00.000Z",
    body: "released\n",
    task: released,
  });

  const newer = createTask({
    id: NEW,
    creator: "alice-claude",
    title: "New, untouched",
    target: "machine:build-01",
  });
  const fresh = event(newer, { ts: "2026-11-05T10:08:00.000Z" });
  const tasks = reduceTasks([created, claim, start, release, fresh], now);
  return [{ room: "ops", tasks }];
}

describe("the order the worker claims in", () => {
  it("takes a released older task ahead of a newer one, though the agenda lists it last", () => {
    const now = Date.parse("2026-11-05T10:20:00.000Z");
    const agenda = buildAgenda(rooms(now), ME, { includeUnclaimed: true }, "build-01");

    // The agenda's own order, unchanged by this work: the newer task was
    // updated at 10:08, the released one at 10:10, so the released one is
    // second. That is right for attention and wrong for a queue.
    assert.deepEqual(
      agenda.entries.map((entry) => entry.status.task.id),
      [NEW, OLD],
    );
    assert.deepEqual(
      agenda.entries.map((entry) => entry.status.priority),
      ["normal", "normal"],
      "the priority is the one each task was created with",
    );

    // The worker reads the same entries and takes the older task first: same
    // priority, so creation order decides, and releasing did not move it.
    const { candidates } = selectCandidates(agenda, policy({ trustedRequesters: [] }));
    assert.deepEqual(
      candidates.map((candidate) => candidate.taskId),
      [OLD, NEW],
    );
  });
});
