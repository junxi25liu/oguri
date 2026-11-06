/**
 * Fixtures for the main dashboard's read-only execution-centre fold (ADR 0028).
 *
 * These tests never start the web server, a daemon or an agent. They feed the
 * same shapes `readDashboard` reads — two machines, a blocked task, a tagged
 * superagent report, a missing price — into the pure fold, which is where the
 * difference between "observed", "reported" and "unknown" is decided.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgendaCounts, MachineAgentRow, MachineRow, PresenceRow } from "@oguri/core";
import type { RunRecord } from "@oguri/worker";

import type { MessageView, RoomView, TaskView } from "../src/web/data.ts";
import { READ_METHODS, ReadOnlyBackend } from "../src/web/data.ts";
import {
  alerts,
  buildExecutionCenter,
  localExecution,
  machineOfTask,
  policyView,
  superagentObservation,
  syncView,
  type ExecutionInput,
  type LocalPolicyFacts,
  type LocalUsageFacts,
} from "../src/web/execution.ts";
import { needsYouForTask, sortNeedsYou } from "../src/web/needs-you.ts";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");

function task(id: string, extra: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: `Task ${id}`,
    state: "open",
    health: "active",
    creator: "intake-bot",
    assignee: null,
    assigneeMachine: null,
    target: null,
    updatedAt: "2026-11-04T11:59:00.000Z",
    stale: false,
    dependsOn: [],
    parent: null,
    children: [],
    source: "feishu",
    requester: "ou_alice",
    definition: "A task definition long enough to need folding in the reading view.",
    waitingOn: [],
    invalidEvents: [],
    currentMessageId: `M-${id}`,
    thread: `TH-${id}`,
    requires: [],
    ready: true,
    ...extra,
  };
}

function message(id: string, extra: Partial<MessageView> = {}): MessageView {
  return {
    id,
    from: "worker-a",
    ts: "2026-11-04T11:58:00.000Z",
    kind: "status",
    needs: "none",
    thread: `TH-${id}`,
    taskId: null,
    external: null,
    relay: null,
    excerpt: "A short excerpt",
    tags: [],
    refs: [],
    link: null,
    ...extra,
  };
}

function agent(id: string, extra: Partial<MachineAgentRow> = {}): MachineAgentRow {
  return {
    id,
    tool: "claude",
    human: null,
    status: "live",
    lastSeen: "2026-11-04T11:59:00.000Z",
    lastActivity: "2026-11-04T11:59:00.000Z",
    sessions: 1,
    rooms: ["ops"],
    role: "worker",
    focus: "ledger",
    workspace: "acme/payments",
    capabilities: ["typescript", "git"],
    ...extra,
  } as MachineAgentRow;
}

function machine(id: string, self: boolean, agents: MachineAgentRow[]): MachineRow {
  return {
    id,
    label: id,
    humans: ["Alexander"],
    contested: false,
    self,
    live: agents.length,
    agents,
  } as MachineRow;
}

function run(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    taskId: id,
    room: "ops",
    title: `Task ${id}`,
    runner: "claude",
    startedAt: "2026-11-04T09:00:00.000Z",
    outcome: "running",
    ...extra,
  } as RunRecord;
}

const counts: AgendaCounts = {
  assigned: 0,
  offered: 0,
  capable: 0,
  created: 0,
  unclaimed: 0,
  stale: 0,
  blocked: 0,
  stuck: 0,
  inFlight: 0,
  needsAttention: 0,
};

function room(extra: Partial<RoomView> = {}): RoomView {
  return {
    room: "ops",
    tasks: [],
    messages: [],
    needsYou: [],
    ...extra,
  };
}

function input(extra: Partial<ExecutionInput> = {}): ExecutionInput {
  const machines = [
    machine("local", true, [agent("worker-a")]),
    machine("remote", false, [agent("worker-b")]),
  ];
  const status = {
    networkId: "acme",
    agentId: "worker-a",
    remote: "https://github.com/acme/transport.git",
    health: {
      lastSyncAt: "2026-11-04T11:59:30.000Z",
      ageSeconds: 30,
      degraded: false,
      reason: null,
    },
    daemon: { observed: true, sessionLive: true, loopRunning: true, cadence: "5s" },
  } as unknown as Record<string, unknown>;
  return {
    generatedAt: new Date(NOW).toISOString(),
    mode: "daemon",
    now: NOW,
    status,
    machines,
    presence: [
      {
        id: "worker-a",
        status: "live",
        lastSeen: "2026-11-04T11:59:00.000Z",
        sessions: 1,
      } as PresenceRow,
    ],
    agenda: { counts },
    rooms: [],
    runs: [],
    needsHuman: [{ id: "H1", room: "ops", from: "alice", ts: "", excerpt: "Please decide" }],
    agendaEntries: [],
    errors: [],
    readMethods: READ_METHODS,
    ...extra,
  };
}

describe("web execution centre: pure read-only fold", () => {
  it("preserves the read-only method contract", async () => {
    assert.deepEqual(
      [...READ_METHODS],
      ["status", "machines", "presence", "agenda", "tasks", "read", "inbox"],
    );
    const guarded = new ReadOnlyBackend({
      call: async (method: string) => method,
    } as never);
    for (const allowed of READ_METHODS) {
      assert.equal(await guarded.call(allowed), allowed);
    }
    for (const mutating of ["send", "answer", "claim", "create", "delete", "write"]) {
      await assert.rejects(
        guarded.call(mutating as never),
        new RegExp(`the dashboard does not call '${mutating}'`),
      );
    }
    const view = buildExecutionCenter(input({ readMethods: [] }));
    assert.deepEqual(view.readMethods, [], "the view reports the methods actually used");
  });

  it("counts two machines' tasks and keeps local runs on this machine only", () => {
    const local = task("T1", { state: "in_progress", assigneeMachine: "local" });
    const queued = task("T2", { state: "open", target: "machine:remote" });
    const blocked = task("T3", { state: "blocked", assigneeMachine: "local" });
    const done = task("T4", { state: "completed", target: "machine:remote" });
    const runs = [run("T1"), run("T3", { outcome: "blocked" })];
    const view = buildExecutionCenter(
      input({ rooms: [room({ tasks: [local, queued, blocked, done] })], runs }),
    );
    assert.equal(view.overview.counts.machines, 2);
    assert.equal(view.overview.counts.agents, 2);
    assert.equal(view.overview.counts.liveAgents, 2);
    assert.deepEqual(
      [
        view.overview.counts.running,
        view.overview.counts.queued,
        view.overview.counts.blocked,
        view.overview.counts.completed,
        view.overview.counts.networkTasks,
      ],
      [1, 1, 1, 1, 4],
    );
    const [own, remote] = view.machines ?? [];
    assert.equal(own?.tasks.length, 2);
    assert.equal(remote?.tasks.length, 2);
    assert.equal(own?.localRuns?.length, 2, "only this machine has local run records");
    assert.equal(remote?.localRuns, null, "no remote telemetry is invented");
    assert.equal(remote?.policy, null, "no remote policy is guessed");
    assert.deepEqual(view.overview.local.scope, "this machine only");
  });

  it("treats a failed machine read as unknown, not an empty team", () => {
    const view = buildExecutionCenter(
      input({ machines: null, errors: ["machines: transport unavailable"] }),
    );
    assert.equal(view.machines, null);
    assert.equal(view.overview.counts.machines, null);
    assert.equal(view.overview.counts.liveAgents, null);
    assert.equal(
      view.overview.alerts.some((a) => a.text.includes("machines")),
      true,
    );
    assert.equal(view.overview.sync.confidence, "observed");
  });

  it("never draws a policy-enabled superagent as a live process", () => {
    const report = message("M-big", {
      from: "worker-b",
      ts: "2026-11-04T11:57:00.000Z",
      tags: ["from-superagent", "to-small"],
      excerpt: "Deploy a worker on remote",
    });
    const small = message("M-small", {
      from: "worker-b",
      ts: "2026-11-04T11:56:00.000Z",
      tags: ["superagent-small"],
    });
    const policy: LocalPolicyFacts = {
      workerEnabled: true,
      bigEnabled: true,
      smallEnabled: true,
      runners: ["claude", "codex"],
      maxWorkers: 2,
      maxPerHour: 12,
    };
    const view = buildExecutionCenter(
      input({ rooms: [room({ messages: [report, small] })], policy }),
    );
    const own = view.machines?.[0];
    const remote = view.machines?.[1];
    assert.equal(own?.policy?.known, true);
    assert.equal(own?.policy?.bigEnabled, true);
    assert.equal(own?.policy?.maxPerHour, 12);
    assert.equal(own?.policy?.maxPerHourLabel, "runs/hour", "a run cap is not a dollar budget");
    assert.equal(remote?.agents[0]?.superagent?.role, "big");
    assert.equal(remote?.agents[0]?.superagent?.note, "message observed; process state unknown");
    assert.equal(remote?.agents[0]?.status, "live", "presence comes from cards, not the report");
    assert.equal(superagentObservation("worker-a", [report]), null, "author must match");
    assert.equal(superagentObservation("worker-b", []), null);
  });

  it("shows unknown, not zero, when local cost or policy is unavailable", () => {
    const usage: LocalUsageFacts = { runs: 3, costUsd: null, unpricedRuns: 3 };
    const view = buildExecutionCenter(input({ usage, runs: [run("T1")] }));
    assert.equal(view.overview.local.todayRuns, 3);
    assert.equal(view.overview.local.todayCostUsd, null);
    assert.equal(view.overview.local.costAvailable, false);
    assert.equal(
      view.overview.local.costComplete,
      false,
      "no figure is certainly not a complete one",
    );
    assert.equal(view.overview.local.costSource, null);
    assert.equal(view.overview.local.maxPerHour, null);
    assert.equal(view.overview.local.maxConcurrent, null);
    assert.equal(view.machines?.[0]?.policy?.known, false);
    assert.equal(
      localExecution([run("T1")], { costUsd: 0, unpricedRuns: 0 }, null, NOW).todayCostUsd,
      0,
      "a real zero is kept",
    );
    assert.equal(policyView(null).workerEnabled, null);
    assert.deepEqual(
      localExecution([run("T1")], null, null, NOW).runners,
      [],
      "historical runs do not establish the current policy runner list",
    );
  });

  it("never presents a partial figure as a complete total", () => {
    // A run that printed no price is real spend outside the subtotal. The fold
    // must carry the gap through, not round it away.
    const partial = localExecution([], { costUsd: 1.25, unpricedRuns: 2 }, null, NOW);
    assert.equal(partial.todayCostUsd, 1.25);
    assert.equal(partial.todayUnpricedRuns, 2);
    assert.equal(partial.costComplete, false);
    assert.equal(
      localExecution([], { costUsd: 1.25, unpricedRuns: 0 }, null, NOW).costComplete,
      true,
    );
    // An older caller that does not say cannot claim completeness either.
    const silent = localExecution([], { costUsd: 1.25 }, null, NOW);
    assert.equal(silent.todayUnpricedRuns, null);
    assert.equal(silent.costComplete, false);
    // Nor can a null figure be a complete one, whatever the count says.
    assert.equal(
      localExecution([], { costUsd: null, unpricedRuns: 0 }, null, NOW).costComplete,
      false,
    );
    assert.equal(localExecution([], null, null, NOW).costComplete, false);
  });

  it("surfaces degraded sync, blocked tasks and partial room reads", () => {
    const status = {
      health: { degraded: true, reason: "sync failed", lastSyncAt: null, ageSeconds: 900 },
    };
    const broken = room({ room: "ops", error: "tasks: no such ref" });
    const visible = room({
      room: "build",
      tasks: [task("T9", { state: "stuck" })],
    });
    const partial = room({
      room: "deploys",
      tasks: [task("T10", { state: "in_progress" })],
      error: "messages: no such ref",
    });
    const view = buildExecutionCenter(
      input({
        status,
        rooms: [broken, visible, partial],
        errors: ["tasks: no such ref", "messages: no such ref"],
      }),
    );
    assert.equal(view.overview.sync.degraded, true);
    assert.equal(view.overview.counts.blocked, 1);
    assert.deepEqual(
      view.overview.alerts.map((a) => a.level),
      ["critical", "critical", "warning", "warning", "info", "info"],
    );
    assert.equal(view.tasks[0]?.roomError, null, "a failed read with no tasks has no task detail");
    const partialDetail = view.tasks.find((t) => t.id === "T10");
    assert.equal(
      partialDetail?.roomError,
      "messages: no such ref",
      "a partial read is visible on its tasks",
    );
    assert.equal(syncView(null, NOW, "direct").degraded, null, "absent health is unknown");
  });

  it("locates a task's latest message, question, runner and parent/child links", () => {
    const parent = task("P", { state: "blocked", assigneeMachine: "local" });
    const child = task("C", { parent: "P", currentMessageId: "M-C" });
    const latest = message("M-C", {
      thread: "TH-C",
      taskId: "C",
      kind: "result",
      link: "https://github.com/acme/app/pull/7",
      refs: ["https://github.com/acme/app/pull/7"],
      excerpt: "Published a result",
    });
    const needs = {
      reason: "attention" as const,
      taskId: "C",
      title: "Task C",
      room: "ops",
      source: "feishu",
      requester: "ou_alice",
      since: "2026-11-04T11:00:00.000Z",
      link: null,
      messageId: "M-Q",
      thread: "TH-C",
    };
    const runs = [run("C", { outcome: "completed", runner: "codex" })];
    const view = buildExecutionCenter(
      input({
        rooms: [room({ tasks: [parent, child], messages: [latest], needsYou: [needs] })],
        runs,
      }),
    );
    const detail = view.tasks.find((t) => t.id === "C");
    assert.equal(detail?.currentMessage?.id, "M-C");
    assert.equal(detail?.currentMessage?.link, "https://github.com/acme/app/pull/7");
    assert.equal(detail?.runner, "codex");
    assert.equal(detail?.needsYou[0]?.reason, "attention");
    assert.equal(detail?.threadMessages.length, 1);
    assert.equal(machineOfTask(parent), "local");
    assert.equal(machineOfTask(child), null);
    assert.equal(needsYouForTask([needs], "C")?.reason, "attention");
    assert.equal(needsYouForTask([needs], "P"), null);
    assert.equal(
      sortNeedsYou([needs, { ...needs, taskId: "A", since: "2026-11-04T10:00:00.000Z" }])[0]
        ?.taskId,
      "A",
    );
  });

  it("keeps legacy top-level keys alongside the new view", () => {
    const view = buildExecutionCenter(input());
    assert.equal(view.agent, "worker-a");
    assert.equal(view.network, "acme");
    assert.equal(view.mode, "daemon");
    assert.equal(view.generatedAt, new Date(NOW).toISOString());
    assert.ok("overview" in view);
    assert.ok("tasks" in view);
    assert.ok("activity" in view);
    assert.ok("runs" in view);
  });

  it("raises a critical alert for a run whose report failed three times, and not before", () => {
    const record = (attempts: number): RunRecord => ({
      taskId: "T1",
      room: "ops",
      title: "t",
      runner: "claude",
      startedAt: "2026-11-04T10:00:00.000Z",
      outcome: "unreported",
      pendingReport: {
        action: "completed",
        body: "x",
        refs: [],
        needsHuman: false,
        attempts,
        nextAt: "2026-11-04T12:05:00.000Z",
      },
    });
    const sync = syncView(null, NOW, "direct");
    const counts = {} as Parameters<typeof alerts>[0];
    const stuckText = /could not report their result/;
    assert.equal(
      alerts(counts, sync, [], [], [], [record(2)]).some((a) => stuckText.test(a.text)),
      false,
    );
    const raised = alerts(counts, sync, [], [], [], [record(3)]).find((a) =>
      stuckText.test(a.text),
    );
    assert.equal(raised?.level, "critical");
  });
});
