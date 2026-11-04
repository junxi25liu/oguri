import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { ROLLUP_NOTE_PREFIX, rollupParent } from "../src/rollup.ts";
import { Worker } from "../src/worker.ts";
import { ME, fakeBackend, policy, type FakeTask } from "./fake-backend.ts";

const PARENT = "01JPPPPPPPPPPPPPPPPPPPPPPP";
const KID_A = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const KID_B = "01JBBBBBBBBBBBBBBBBBBBBBBB";

function family(
  parent: Partial<FakeTask>,
  kids: { id: string; state: string; events?: FakeTask["events"] }[],
): FakeTask[] {
  return [
    {
      id: PARENT,
      title: "Release 2.0",
      state: "in_progress",
      assignee: ME,
      children: kids.map(({ id, state }) => ({ id, state })),
      ...parent,
    },
    ...kids.map((kid) => ({
      id: kid.id,
      title: `Step ${kid.id.slice(-1)}`,
      state: kid.state,
      assignee: "carol-codex",
      relation: "unclaimed",
      hidden: true,
      ...(kid.events === undefined ? {} : { events: kid.events }),
    })),
  ];
}

describe("parent roll-up", () => {
  it("completes a parent whose children all completed, listing them and their refs", async () => {
    const { backend, updates } = fakeBackend(
      family({}, [
        {
          id: KID_A,
          state: "completed",
          events: [
            { action: "started" },
            { action: "completed", refs: ["branch:step-a", "https://github.com/acme/app/pull/1"] },
          ],
        },
        { id: KID_B, state: "completed", events: [{ action: "completed" }] },
      ]),
    );
    const outcome = await rollupParent(backend, ME, "ops", PARENT);
    assert.equal(outcome.action, "completed");
    const [done] = updates();
    assert.equal(done?.action, "completed");
    assert.equal(done?.taskId, PARENT);
    assert.match(done?.body ?? "", /all 2 subtask\(s\) completed/);
    assert.match(done?.body ?? "", new RegExp(`${KID_A} Step A — branch:step-a`));
    assert.match(done?.body ?? "", new RegExp(`${KID_B} Step B`));
    assert.deepEqual(done?.refs, ["branch:step-a", "https://github.com/acme/app/pull/1"]);
  });

  it("starts a parent that was only claimed, since a task completes from in progress", async () => {
    const { backend, updates } = fakeBackend(
      family({ state: "claimed" }, [{ id: KID_A, state: "completed" }]),
    );
    await rollupParent(backend, ME, "ops", PARENT);
    assert.deepEqual(
      updates().map((u) => u.action),
      ["started", "completed"],
    );
  });

  it("leaves a parent alone while children work, or when it is not ours or has none", async () => {
    const cases: [FakeTask[], RegExp][] = [
      [family({}, [{ id: KID_A, state: "in_progress" }]), /still in progress/],
      [family({ assignee: "carol-codex" }, [{ id: KID_A, state: "completed" }]), /not held/],
      [family({ state: "completed" }, [{ id: KID_A, state: "completed" }]), /already completed/],
      [family({}, []), /no subtasks/],
    ];
    for (const [tasks, reason] of cases) {
      const { backend, updates } = fakeBackend(tasks);
      const outcome = await rollupParent(backend, ME, "ops", PARENT);
      assert.equal(outcome.action, "none");
      assert.match(outcome.reason, reason);
      assert.deepEqual(updates(), []);
    }
  });

  it("notes once on the parent when a child is cancelled or waits for a person", async () => {
    const tasks = family({}, [
      { id: KID_A, state: "cancelled" },
      { id: KID_B, state: "blocked", events: [{ action: "blocked", needs: "human" }] },
    ]);
    const { backend, updates, byId } = fakeBackend(tasks);
    const outcome = await rollupParent(backend, ME, "ops", PARENT);
    assert.equal(outcome.action, "noted");
    const [note] = updates();
    assert.equal(note?.action, "progressed");
    assert.ok(note?.body.startsWith(ROLLUP_NOTE_PREFIX));
    assert.match(note?.body ?? "", new RegExp(`${KID_A} Step A: cancelled`));
    assert.match(note?.body ?? "", new RegExp(`${KID_B} Step B: blocked, waiting for a person`));

    // The note is now in the parent's history; a second look says nothing.
    const parent = byId.get(PARENT) as FakeTask;
    parent.events = [{ action: "progressed", from: ME, body: note?.body ?? "" }];
    const again = await rollupParent(backend, ME, "ops", PARENT);
    assert.equal(again.action, "none");
    assert.match(again.reason, /already told/);
    assert.equal(updates().length, 1);
  });

  it("does not note a child that is blocked on its own agent", async () => {
    const { backend, updates } = fakeBackend(
      family({}, [
        { id: KID_A, state: "blocked", events: [{ action: "blocked", needs: "agent" }] },
      ]),
    );
    const outcome = await rollupParent(backend, ME, "ops", PARENT);
    assert.equal(outcome.action, "none");
    assert.deepEqual(updates(), []);
  });
});

describe("roll-up in the worker pass", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "oguri-worker-rollup-"));
  });

  it("completes a held parent once its children are done, and does not repeat a no-op", async () => {
    const tasks = family({ relation: "assigned" }, [
      { id: KID_A, state: "completed" },
      { id: KID_B, state: "in_progress" },
    ]);
    const { backend, calls, updates } = fakeBackend(tasks);
    const worker = new Worker({
      backend,
      agentId: ME,
      home,
      loadPolicy: async () => policy({ workdir: home }),
    });
    const first = await worker.pass();
    assert.equal(first.rolledUp, undefined);
    // Children still at work: the agenda alone says so, no extra reads.
    assert.ok(!calls.some((c) => c.method === "taskShow"));

    (tasks[0] as FakeTask).children = [
      { id: KID_A, state: "completed" },
      { id: KID_B, state: "completed" },
    ];
    const second = await worker.pass();
    assert.deepEqual(second.rolledUp, [{ room: "ops", taskId: PARENT, action: "completed" }]);
    assert.equal(updates().at(-1)?.action, "completed");
  });
});
