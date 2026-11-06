import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DEFAULT_SUPERAGENT_POLICY, type SuperagentPolicy, type WorkerPolicy } from "@oguri/core";

import { SmallSuperagent } from "../src/small.ts";

/**
 * What a small superagent says about the workers its machine holds. Found
 * supervising a real plan: the plan's parent, held by the machine and waiting
 * for its steps, was reported as a quiet worker, and Big spent a coordination
 * turn deciding to ignore it.
 */

const NOW = Date.parse("2026-11-04T07:00:00.000Z");
const AGENT = "alice-claude";
const OLD = new Date(NOW - 60 * 60_000).toISOString();

function entry(id: string, title: string) {
  return {
    room: "superagent-work",
    status: {
      task: { id, title, state: "in_progress", assignee: AGENT },
      health: "ok",
      updatedAt: OLD,
      thread: id,
      currentMessageId: id,
    },
  };
}

let home: string;
before(async () => {
  home = await mkdtemp(join(tmpdir(), "oguri-small-"));
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("a small superagent's reports", () => {
  it("reports a running worker that went quiet, never a held task that is not running", async () => {
    const sent: { room: string; input: { thread: string; tags: string[] } }[] = [];
    const backend = {
      mode: "direct",
      async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === "status") return { subscriptions: ["superagent", "superagent-work"] } as T;
        if (method === "agenda")
          return {
            entries: [
              entry("01ARZ3NDEKTSV4RRFFQ69G5F01", "a step that went quiet"),
              entry("01ARZ3NDEKTSV4RRFFQ69G5F02", "a plan waiting for its steps"),
            ],
          } as T;
        if (method === "send") sent.push(params as never);
        return {} as T;
      },
      async networks() {
        return [];
      },
      async close() {},
    };
    const base = structuredClone(DEFAULT_SUPERAGENT_POLICY);
    const superagent: SuperagentPolicy = {
      ...base,
      small: { ...base.small, enabled: true, talk: false },
    };
    const small = new SmallSuperagent({
      backend: backend as never,
      agentId: AGENT,
      machine: "mac-mini",
      home,
      loadPolicy: async () => ({ superagent, worker: {} as WorkerPolicy }),
      running: () => new Set(["01ARZ3NDEKTSV4RRFFQ69G5F01"]),
      now: () => NOW,
    });
    const report = await small.pass();
    assert.deepEqual(
      report.reported.map((r) => [r.taskId, r.reason]),
      [["01ARZ3NDEKTSV4RRFFQ69G5F01", "quiet"]],
    );
    assert.deepEqual(
      sent.map((s) => s.input.thread),
      ["01ARZ3NDEKTSV4RRFFQ69G5F01"],
    );
  });
});
