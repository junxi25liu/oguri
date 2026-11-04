import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Network } from "@oguri/core";

import { maybeSeal, type SyncLoopContext } from "../src/daemon/sync-loop.ts";

/**
 * The automatic-seal guard is per network. A single flag used to cover the
 * whole daemon, so one network mid-seal silently skipped every other network's
 * seal for as long as it ran.
 */

function context(sealing: Set<string>, log: string[]): SyncLoopContext {
  return {
    isSealing: (id: string) => sealing.has(id),
    setSealing: (id: string, on: boolean) => {
      if (on) sealing.add(id);
      else sealing.delete(id);
    },
    log: (line: string) => log.push(line),
  } as unknown as SyncLoopContext;
}

function network(checked: string[], id: string, gate?: Promise<void>): Network {
  return {
    roomsNeedingSeal: async () => {
      checked.push(id);
      await gate;
      return [];
    },
  } as unknown as Network;
}

describe("automatic sealing guard", () => {
  it("lets a second network seal while the first is still sealing", async () => {
    const sealing = new Set<string>();
    const checked: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = context(sealing, []);

    const slow = maybeSeal(ctx, "alpha", network(checked, "alpha", gate));
    await maybeSeal(ctx, "beta", network(checked, "beta"));
    assert.deepEqual(checked, ["alpha", "beta"], "beta must not wait on alpha");

    await maybeSeal(ctx, "alpha", network(checked, "alpha-again"));
    assert.deepEqual(checked, ["alpha", "beta"], "alpha still never seals twice at once");

    release();
    await slow;
    assert.equal(sealing.size, 0, "every guard is released");
  });
});
