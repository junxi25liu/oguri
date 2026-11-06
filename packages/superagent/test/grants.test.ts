import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SUPERAGENT_POLICY } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { ROUTE_KINDS, RouteError, parseRouteDecision, type RouteScope } from "../src/decision.ts";
import { BIG_KINDS, act, type Conversation } from "../src/act.ts";

/**
 * Big cannot grant itself a runner. Its model's reply is parsed into a closed
 * set of decisions, none of which touches runner grants, and its code has no
 * path to the grants store at all. What it can do when a runner is missing is
 * pass the worker's request on to the owner, which `big.test.ts` covers for
 * every `task-question` a worker asks.
 */

const scope: RouteScope = {
  kinds: BIG_KINDS,
  rooms: ["superagent"],
  targets: ["box-claude"],
  capabilities: [],
  tasks: [],
  mayAnswer: true,
  maxSteps: 8,
};

describe("Big and runner grants", () => {
  it("has no decision kind that grants or revokes a runner", () => {
    // `request_runner` only asks the owner to authorize; the test below proves no path reaches the store.
    for (const kind of ROUTE_KINDS.filter((k) => k !== "request_runner")) {
      assert.doesNotMatch(kind, /grant|revoke|runner|policy/);
    }
    assert.ok(ROUTE_KINDS.some((kind) => kind === "request_runner"));
    for (const kind of ["grant", "runner-grant", "revoke", "policy"]) {
      assert.throws(
        () => parseRouteDecision({ kind, runner: "codexm", reason: "I need it" }, scope),
        (error: unknown) =>
          error instanceof RouteError && /'kind' must be one of/.test(error.message),
      );
    }
  });

  it("only asks with request_runner: one needs-human question, no grant", async () => {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const backend = {
      mode: "direct",
      call: async (method: string, params: Record<string, unknown> = {}) => {
        sent.push({ method, params });
        return {};
      },
      networks: async () => [],
      close: async () => undefined,
    } as unknown as Backend;
    const decision = parseRouteDecision(
      { kind: "request_runner", runner: "codexm", reason: "the task names runner: codexm" },
      scope,
    );
    await act(
      { backend, agentId: "alice-big", policy: DEFAULT_SUPERAGENT_POLICY, log: () => undefined },
      {
        room: "superagent",
        thread: "",
        messageId: "01K0000000000000000000000A",
        author: "alice-claude",
        text: "use codexm",
        context: [],
      } as unknown as Conversation,
      decision,
      ["superagent"],
    );
    assert.deepEqual(
      sent.map((call) => call.method),
      ["send"],
      "a message, and no other write",
    );
    const input = sent[0]?.params["input"] as { needs: string; body: string };
    assert.equal(input.needs, "human");
    assert.match(input.body, /oguri runner grant codexm/);
  });

  it("never reaches the grants store from its own code", async () => {
    const dir = join(import.meta.dirname, "..", "src");
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = await readFile(join(dir, file), "utf8");
      assert.doesNotMatch(source, /RunnerGrantStore|grants\.json|\.grant\(/, file);
    }
  });
});
