import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

import { createMessage, createTask, ulid, type Message, type Task } from "@oguri/protocol";

import { defaultIdentity } from "../src/config.ts";
import { Layout } from "../src/layout.ts";
import { Network } from "../src/network.ts";
import { Sealer } from "../src/seal/sealer.ts";
import { buildAgenda } from "../src/task/agenda.ts";
import { reduceTaskDetail, reduceTasks, type TaskStatus } from "../src/task/tasks.ts";

const exec = promisify(execFile);
const NOW = Date.parse("2026-08-12T12:00:00.000Z");

process.env["GIT_AUTHOR_NAME"] = "oguri test";
process.env["GIT_AUTHOR_EMAIL"] = "test@oguri.invalid";
process.env["GIT_COMMITTER_NAME"] = "oguri test";
process.env["GIT_COMMITTER_EMAIL"] = "test@oguri.invalid";

function taskEvent(
  from: string,
  task: Task,
  options: { inReplyTo?: string; thread?: string } = {},
): Message {
  const id = ulid();
  return createMessage({
    id,
    room: "tasks",
    from,
    authorKind: "agent",
    kind: task.action === "created" ? "question" : "status",
    needs:
      task.state === "open" || task.state === "blocked" || task.state === "stuck"
        ? "agent"
        : "none",
    mentions: task.action === "created" ? [task.target ?? "@room"] : [],
    thread: options.thread ?? id,
    ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
    ts: "2026-08-12T11:59:00.000Z",
    body: `${task.action}\n`,
    task,
  });
}

/**
 * One task's event chain, appended to as the test goes.
 *
 * Every event mints its ULID when it is appended, so the order of `append`
 * calls across chains IS the room's canonical order — which is the thing these
 * tests are about.
 */
class Chain {
  readonly events: Message[] = [];
  task: Task;

  constructor(creator: string, input: Omit<Parameters<typeof createTask>[0], "id" | "creator">) {
    this.task = createTask({ id: ulid(), creator, ...input });
    this.events.push(taskEvent(creator, this.task));
  }

  get id(): string {
    return this.task.id;
  }

  /** An event replying to the latest one, without advancing the chain. */
  branch(
    from: string,
    change: Partial<Task> & Pick<Task, "action">,
    drop: (keyof Task)[] = [],
  ): Message {
    const next = { ...this.task, ...change } as Task;
    for (const key of drop) delete next[key];
    return taskEvent(from, next, {
      inReplyTo: (this.events.at(-1) as Message).header.id,
      thread: (this.events[0] as Message).header.thread,
    });
  }

  append(
    from: string,
    change: Partial<Task> & Pick<Task, "action">,
    drop: (keyof Task)[] = [],
  ): Message {
    const event = this.branch(from, change, drop);
    this.events.push(event);
    this.task = event.header.task as Task;
    return event;
  }

  claim(by: string, extra: Partial<Task> = {}): Message {
    return this.append(by, { action: "claimed", state: "claimed", assignee: by, ...extra });
  }

  /** A claim event that is not added to the chain: what a losing claimant wrote. */
  strayClaim(by: string, extra: Partial<Task> = {}): Message {
    return this.branch(by, { action: "claimed", state: "claimed", assignee: by, ...extra });
  }

  release(by: string, extra: Partial<Task> = {}): Message {
    return this.append(by, { action: "released", state: "open", ...extra }, [
      "assignee",
      "claimantCapabilities",
    ]);
  }

  /** Claimed → started → completed, by one agent. */
  finish(by: string): void {
    this.claim(by);
    this.append(by, { action: "started", state: "in_progress" });
    this.append(by, { action: "completed", state: "completed" });
  }
}

function statusOf(messages: readonly Message[], id: string): TaskStatus {
  const status = reduceTasks(messages, NOW).find((candidate) => candidate.task.id === id);
  assert.ok(status !== undefined, `no status for ${id}`);
  return status;
}

describe("dependency-gated claims", () => {
  it("rejects a claim made before the dependency completed, and accepts one after", () => {
    const schema = new Chain("alice-codex", { title: "Migrate the schema" });
    const api = new Chain("alice-codex", { title: "Ship the API", dependsOn: [schema.id] });

    const early = api.strayClaim("bob-claude");
    schema.finish("carol-cursor");
    const late = api.claim("bob-claude");

    const room = [...schema.events, ...api.events, early];
    const status = statusOf(room, api.id);
    assert.equal(status.task.state, "claimed");
    assert.equal(status.task.assignee, "bob-claude");
    assert.equal(status.currentMessageId, late.header.id);
    const rejected = status.invalidEvents.find((event) => event.messageId === early.header.id);
    assert.equal(rejected?.code, "DEPENDENCY_PENDING");
    assert.match(rejected?.reason ?? "", /dependencies are not completed/);
  });

  it("reaches the same verdict whatever order the events arrive in", () => {
    const schema = new Chain("alice-codex", { title: "Schema" });
    const api = new Chain("alice-codex", { title: "API", dependsOn: [schema.id] });
    schema.claim("carol-cursor");
    schema.append("carol-cursor", { action: "started", state: "in_progress" });
    // The claim lands between the dependency's start and its completion: a
    // reader that fetched the completion first must still reject it.
    const claim = api.claim("bob-claude");
    schema.append("carol-cursor", { action: "completed", state: "completed" });

    const room = [...schema.events, ...api.events];
    // Every rotation plus the reverse: the input order is whatever a reader
    // happened to fetch, and must not matter.
    const orders = [[...room].reverse()];
    for (let shift = 0; shift < room.length; shift++) {
      orders.push([...room.slice(shift), ...room.slice(0, shift)]);
    }
    for (const order of orders) {
      const status = statusOf(order, api.id);
      assert.equal(status.task.state, "open");
      assert.deepEqual(
        status.invalidEvents.map((event) => [event.messageId, event.code]),
        [[claim.header.id, "DEPENDENCY_PENDING"]],
      );
      assert.equal(status.ready, true, "the dependency has completed by now");
    }
  });

  it("reports unmet dependencies and readiness", () => {
    const a = new Chain("alice-codex", { title: "A" });
    const b = new Chain("alice-codex", { title: "B" });
    const c = new Chain("alice-codex", { title: "C", dependsOn: [a.id, b.id] });
    a.finish("bob-claude");
    b.claim("bob-claude");

    const status = statusOf([...a.events, ...b.events, ...c.events], c.id);
    assert.deepEqual(status.waitingOn, [{ id: b.id, state: "claimed" }]);
    assert.equal(status.ready, false);
    assert.equal(status.health, "active");
  });

  it("names a dependency the room does not carry as missing", () => {
    const ghost = ulid();
    const task = new Chain("alice-codex", { title: "Orphan", dependsOn: [ghost] });
    const status = statusOf(task.events, task.id);
    assert.deepEqual(status.waitingOn, [{ id: ghost, state: "missing" }]);
    assert.equal(status.ready, false);
  });

  it("shows a task behind a cancelled dependency as blocked", () => {
    const dep = new Chain("alice-codex", { title: "Dropped" });
    const task = new Chain("alice-codex", { title: "Behind it", dependsOn: [dep.id] });
    dep.append("alice-codex", { action: "cancelled", state: "cancelled" });

    const status = statusOf([...dep.events, ...task.events], task.id);
    assert.deepEqual(status.waitingOn, [{ id: dep.id, state: "cancelled" }]);
    assert.equal(status.health, "blocked");
    assert.equal(status.ready, false);
  });

  it("does not gate anything but the claim", () => {
    const dep = new Chain("alice-codex", { title: "Pending" });
    const task = new Chain("alice-codex", { title: "Refinable", dependsOn: [dep.id] });
    task.append("bob-claude", { action: "refined", title: "Refined while waiting" });
    const status = statusOf([...dep.events, ...task.events], task.id);
    assert.equal(status.task.title, "Refined while waiting");
    assert.deepEqual(status.invalidEvents, []);
  });
});

describe("attempts", () => {
  it("counts accepted claims, keeps the count across release, and stops at the limit", () => {
    const task = new Chain("alice-codex", { title: "Flaky deploy", maxAttempts: 2 });
    task.claim("bob-claude", { attempt: 1 });
    task.release("bob-claude", { attempt: 1 });
    // An older client omits the counter; the reducer derives it anyway.
    task.append("carol-cursor", { action: "claimed", state: "claimed", assignee: "carol-cursor" }, [
      "attempt",
    ]);
    task.release("carol-cursor", { attempt: 2 });
    const third = task.claim("bob-claude", { attempt: 3 });

    const status = statusOf(task.events, task.id);
    assert.equal(status.task.attempt, 2);
    assert.equal(status.task.state, "open");
    assert.equal(status.ready, false);
    const rejected = status.invalidEvents.find((event) => event.messageId === third.header.id);
    assert.equal(rejected?.code, "ATTEMPTS_EXHAUSTED");
  });

  it("refuses an event that misstates the counter", () => {
    const task = new Chain("alice-codex", { title: "Counted" });
    const wrong = task.strayClaim("bob-claude", { attempt: 5 });
    const status = statusOf([...task.events, wrong], task.id);
    assert.equal(status.task.state, "open");
    assert.match(
      status.invalidEvents.find((event) => event.messageId === wrong.header.id)?.reason ?? "",
      /task_attempt must be 1/,
    );
  });
});

describe("required capabilities", () => {
  it("accepts only a claim that declares every requirement", () => {
    const task = new Chain("alice-codex", { title: "Train", requires: ["gpu", "cuda"] });
    const without = task.strayClaim("bob-claude", { claimantCapabilities: ["gpu"] });
    const withAll = task.claim("carol-cursor", { claimantCapabilities: ["gpu", "cuda"] });

    const status = statusOf([...task.events, without], task.id);
    assert.equal(status.task.assignee, "carol-cursor");
    assert.equal(status.currentMessageId, withAll.header.id);
    const rejected = status.invalidEvents.find((event) => event.messageId === without.header.id);
    assert.equal(rejected?.code, "CAPABILITY_MISSING");
    assert.match(rejected?.reason ?? "", /cuda/);
  });
});

describe("subtasks", () => {
  it("lists children with their states and survives in task detail", () => {
    const parent = new Chain("alice-codex", { title: "Epic" });
    const one = new Chain("alice-codex", { title: "One", parent: parent.id });
    const two = new Chain("alice-codex", { title: "Two", parent: parent.id });
    one.finish("bob-claude");

    const room = [...parent.events, ...one.events, ...two.events];
    const status = statusOf(room, parent.id);
    assert.deepEqual(status.children, [
      { id: one.id, state: "completed" },
      { id: two.id, state: "open" },
    ]);
    assert.deepEqual(reduceTaskDetail(room, parent.id, NOW)?.children, status.children);
    assert.equal(statusOf(room, one.id).task.parent, parent.id);
  });
});

describe("agenda over the task graph", () => {
  it("reports an offered task with a pending dependency but marks it not ready", () => {
    const dep = new Chain("alice-codex", { title: "First" });
    const offered = new Chain("alice-codex", {
      title: "Second",
      target: "machine:build-box",
      dependsOn: [dep.id],
    });
    const free = new Chain("alice-codex", { title: "Offered and ready", target: "bob-claude" });
    const tasks = reduceTasks([...dep.events, ...offered.events, ...free.events], NOW);

    const agenda = buildAgenda([{ room: "tasks", tasks }], "bob-claude", {}, "build-box");
    const byTitle = new Map(agenda.entries.map((entry) => [entry.status.task.title, entry]));
    assert.equal(byTitle.get("Second")?.relation, "offered");
    assert.equal(byTitle.get("Second")?.ready, false);
    assert.equal(byTitle.get("Offered and ready")?.ready, true);
    // Ready work ranks above work that is still waiting.
    assert.equal(agenda.entries[0]?.status.task.title, "Offered and ready");
  });

  it("lists capability-addressed work as `capable` only for an agent that qualifies", () => {
    const gpu = new Chain("alice-codex", { title: "Needs a GPU", requires: ["gpu"] });
    const plain = new Chain("alice-codex", { title: "Anyone" });
    const tasks = reduceTasks([...gpu.events, ...plain.events], NOW);
    const rooms = [{ room: "tasks", tasks }];

    const capable = buildAgenda(rooms, "bob-claude", { includeCapable: ["gpu", "rust"] });
    const byTitle = new Map(capable.entries.map((entry) => [entry.status.task.title, entry]));
    assert.equal(byTitle.get("Needs a GPU")?.relation, "capable");
    assert.equal(byTitle.get("Needs a GPU")?.ready, true);
    assert.equal(byTitle.get("Anyone")?.relation, "unclaimed");
    assert.equal(capable.counts.capable, 1);
    assert.equal(capable.counts.unclaimed, 1);
    assert.equal(capable.counts.needsAttention, 0);

    const lacking = buildAgenda(rooms, "bob-claude", { includeCapable: ["rust"] });
    const gpuEntry = lacking.entries.find((entry) => entry.status.task.title === "Needs a GPU");
    assert.equal(gpuEntry?.relation, "unclaimed");
    assert.equal(gpuEntry?.ready, false);
    assert.equal(lacking.counts.capable, 0);

    // Without the option nothing changes for plain work, and a task with
    // requirements is never ready: nothing says this agent qualifies.
    const plainAgenda = buildAgenda(rooms, "bob-claude");
    assert.equal(
      plainAgenda.entries.find((entry) => entry.status.task.title === "Anyone")?.ready,
      true,
    );
    assert.equal(
      plainAgenda.entries.find((entry) => entry.status.task.title === "Needs a GPU")?.ready,
      false,
    );
  });

  it("keeps `capable` work listed while this agent has work in flight", () => {
    const mine = new Chain("alice-codex", { title: "In hand" });
    mine.claim("bob-claude");
    mine.append("bob-claude", { action: "started", state: "in_progress" });
    const gpu = new Chain("alice-codex", { title: "Needs a GPU", requires: ["gpu"] });
    const plain = new Chain("alice-codex", { title: "Anyone" });
    const tasks = reduceTasks([...mine.events, ...gpu.events, ...plain.events], NOW);

    const agenda = buildAgenda([{ room: "tasks", tasks }], "bob-claude", {
      includeCapable: ["gpu"],
    });
    const titles = agenda.entries.map((entry) => entry.status.task.title);
    assert.ok(titles.includes("Needs a GPU"), "asked-for capability work is listed");
    assert.ok(!titles.includes("Anyone"), "plain free work is still suppressed while busy");
  });

  it("leaves a creator's own capability task under `created`", () => {
    const gpu = new Chain("bob-claude", { title: "Mine, needs a GPU", requires: ["gpu"] });
    const agenda = buildAgenda(
      [{ room: "tasks", tasks: reduceTasks(gpu.events, NOW) }],
      "bob-claude",
      { includeCapable: ["gpu"] },
    );
    assert.equal(agenda.entries[0]?.relation, "created");
    assert.equal(agenda.entries[0]?.ready, true);
  });
});

describe("task graph through the network", () => {
  let tmp: string;
  let alice: Network;
  let bob: Network;

  /** The error a promise rejected with, or a failure if it resolved. */
  async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
    const error = await promise.then(
      () => assert.fail("expected a refusal"),
      (e: unknown) => e,
    );
    return error as { code?: string; message: string };
  }

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), "oguri-task-graph-"));
    const remote = join(tmp, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    alice = (
      await Network.init({
        layout: new Layout(join(tmp, "alice")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "alice-codex" }),
      })
    ).network;
    await alice.createRoom("graph");
    bob = (
      await Network.init({
        layout: new Layout(join(tmp, "bob")),
        networkId: "acme",
        remote,
        identity: defaultIdentity({ id: "bob-codex" }),
      })
    ).network;
    await bob.joinRoom("graph");
    // About the graph, not about who may take work on: see policy.test.ts.
    await writeFile(join(tmp, "bob", "policy.yaml"), "v: 1\napprovals:\n  inboundWork: never\n");
  });

  after(async () => {
    alice.close();
    bob.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("refuses links to tasks the room does not carry, before writing anything", async () => {
    const before = (await alice.read("graph")).length;
    await assert.rejects(
      alice.createTask("graph", {
        title: "Dangling",
        definition: "Depends on nothing real.",
        dependsOn: [ulid()],
      }),
      /no task .* in room graph/,
    );
    assert.equal((await alice.read("graph")).length, before);
  });

  it("gives each graph refusal its own code, and claims once the graph allows it", async () => {
    const dep = await alice.createTask("graph", {
      title: "Schema",
      definition: "Migrate the schema.",
    });
    const depId = dep.header.task?.id as string;
    const task = await alice.createTask("graph", {
      title: "API on a GPU box",
      definition: "Needs the schema and a GPU.",
      dependsOn: [depId],
      requires: ["gpu"],
      maxAttempts: 1,
    });
    const taskId = task.header.task?.id as string;
    assert.deepEqual(task.header.task?.dependsOn, [depId]);
    await bob.sync();

    const pending = await refusal(bob.claimTask("graph", taskId, "Taking it."));
    assert.equal(pending.code, "DEPENDENCY_PENDING");
    assert.match(pending.message, new RegExp(depId));

    await bob.claimTask("graph", depId, "Doing the schema first.");
    await bob.updateTask("graph", depId, { action: "started", body: "Migrating." });
    await bob.updateTask("graph", depId, { action: "completed", body: "Migrated." });

    const missing = await refusal(bob.claimTask("graph", taskId, "Taking it."));
    assert.equal(missing.code, "CAPABILITY_MISSING");
    assert.match(missing.message, /gpu/);

    // Free-text capabilities that are not capability names are ignored.
    await bob.publishAgentProfile({ capabilities: ["gpu", "Reads Rust fluently"] });
    assert.deepEqual(await bob.taskCapabilities(), ["gpu"]);

    const capableAgenda = await bob.agenda({ includeCapable: true, includeUnclaimed: false });
    const entry = capableAgenda.entries.find((e) => e.status.task.id === taskId);
    assert.equal(entry?.relation, "capable");
    assert.equal(entry?.ready, true);

    const claimed = await bob.claimTask("graph", taskId, "Taking it on the GPU box.");
    assert.equal(claimed.header.task?.attempt, 1);
    assert.deepEqual(claimed.header.task?.claimantCapabilities, ["gpu"]);
    await bob.updateTask("graph", taskId, { action: "released", body: "Out of memory." });

    const [status] = (await bob.listTasks("graph")).filter((s) => s.task.id === taskId);
    assert.equal(status?.task.attempt, 1, "a release keeps the count");
    assert.equal(status?.ready, false);

    const exhausted = await refusal(bob.claimTask("graph", taskId, "One more go."));
    assert.equal(exhausted.code, "ATTEMPTS_EXHAUSTED");
  });

  it("reports subtasks under their parent", async () => {
    const dep = await alice.createTask("graph", { title: "Dep", definition: "First." });
    const task = await alice.createTask("graph", {
      title: "Child",
      definition: "Second.",
      parent: dep.header.task?.id as string,
    });
    const parent = await alice.listTasks("graph");
    assert.deepEqual(parent.find((s) => s.task.id === dep.header.task?.id)?.children, [
      { id: task.header.task?.id, state: "open" },
    ]);
  });

  it("lets a claim assert capabilities beyond the profile, as a worker does", async () => {
    const task = await alice.createTask("graph", {
      title: "Needs macos",
      definition: "Sign the build.",
      requires: ["macos"],
    });
    const taskId = task.header.task?.id as string;
    await bob.sync();
    assert.equal(
      (await refusal(bob.claimTask("graph", taskId, "Taking it."))).code,
      "CAPABILITY_MISSING",
    );
    await assert.rejects(bob.claimTask("graph", taskId, "Taking it.", ["Not A Name"]), /invalid/);
    await assert.rejects(
      bob.updateTask("graph", taskId, { action: "started", body: "x", capabilities: ["macos"] }),
      /only a claim may assert capabilities/,
    );

    const claimed = await bob.claimTask("graph", taskId, "Taking it.", ["macos", "spare"]);
    // Only what the task asks for goes on the event.
    assert.deepEqual(claimed.header.task?.claimantCapabilities, ["macos"]);
    await alice.sync();
    const [status] = (await alice.listTasks("graph")).filter((s) => s.task.id === taskId);
    assert.equal(status?.task.assignee, "bob-codex", "every reader accepts the claim");
  });
});

describe("sealing a task graph", () => {
  it("keeps a completed dependency live while a task that depends on it is in the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "oguri-task-graph-seal-"));
    const remote = join(root, "transport.git");
    await exec("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    const layout = new Layout(join(root, "home"));
    const network = (
      await Network.init({
        layout,
        networkId: "graph-net",
        remote,
        identity: defaultIdentity({ id: "solo-agent" }),
      })
    ).network;
    try {
      await network.createRoom("work");
      const dep = await network.createTask("work", { title: "Dep", definition: "First." });
      const depId = dep.header.task?.id as string;
      await network.claimTask("work", depId, "Mine.");
      await network.updateTask("work", depId, { action: "started", body: "Going." });
      await network.updateTask("work", depId, { action: "completed", body: "Done." });
      const task = await network.createTask("work", {
        title: "After",
        definition: "Second.",
        dependsOn: [depId],
      });
      const taskId = task.header.task?.id as string;
      await network.claimTask("work", taskId, "Now it is ready.");
      await network.updateTask("work", taskId, { action: "started", body: "Going." });

      // A window of one message would prune the whole dependency chain.
      const sealer = new Sealer({
        repo: network.repo,
        layout,
        networkId: "graph-net",
        agentId: "solo-agent",
        remote,
      });
      const policy = {
        windowDays: 3650,
        windowMessages: 1,
        minIntervalHours: 0,
        lockLeaseMinutes: 15,
      };
      await sealer.seal("work", policy);

      const live = await network.read("work");
      const kept = new Set(live.map((message) => message.header.id));
      assert.ok(kept.has(dep.header.id), "the dependency's root stays live");
      const [status] = (await network.listTasks("work")).filter((s) => s.task.id === taskId);
      assert.equal(
        status?.task.state,
        "in_progress",
        "the dependent's claim still reduces as valid",
      );
      assert.deepEqual(status?.invalidEvents, []);
    } finally {
      network.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
