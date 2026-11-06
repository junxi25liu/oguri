import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_LOCAL_POLICY, effectiveConcurrency, type LocalPolicy } from "@oguri/core";

import { workerPolicyFor } from "../src/commands/superagent.ts";

/**
 * The worker policy the small superagent runs with.
 *
 * The load-bearing rule is that the concurrency it reports and the one the
 * engine applies are the same number, and that it may now be as high as 20.
 */

function local(overrides: {
  concurrency?: number;
  maxPerHour?: number;
  small?: { enabled: boolean; maxWorkers: number };
}): LocalPolicy {
  return {
    ...DEFAULT_LOCAL_POLICY,
    worker: {
      ...DEFAULT_LOCAL_POLICY.worker,
      enabled: true,
      runners: { claude: { argv: ["claude", "-p"], worktree: false } },
      concurrency: overrides.concurrency ?? 1,
      maxPerHour: overrides.maxPerHour ?? DEFAULT_LOCAL_POLICY.worker.maxPerHour,
    },
    superagent: {
      ...DEFAULT_LOCAL_POLICY.superagent,
      small: {
        ...DEFAULT_LOCAL_POLICY.superagent.small,
        enabled: overrides.small?.enabled ?? false,
        maxWorkers: overrides.small?.maxWorkers ?? DEFAULT_LOCAL_POLICY.superagent.small.maxWorkers,
      },
    },
  };
}

describe("the small superagent's worker policy", () => {
  it("passes worker.concurrency through when the role is off", () => {
    const policy = workerPolicyFor(local({ concurrency: 6 }));
    assert.equal(policy.concurrency, 6);
    assert.equal(policy.concurrency, effectiveConcurrency(local({ concurrency: 6 })));
  });

  it("uses maxWorkers, up to 20, when the role is on", () => {
    for (const maxWorkers of [1, 5, 8, 12, 16, 20]) {
      const source = local({ concurrency: 2, small: { enabled: true, maxWorkers } });
      const policy = workerPolicyFor(source);
      assert.equal(policy.concurrency, maxWorkers, `maxWorkers ${String(maxWorkers)}`);
      assert.equal(policy.concurrency, effectiveConcurrency(source), "status reads the same value");
    }
  });

  it("never lets the hourly cap undercut the concurrency it applies", () => {
    // A machine allowed 20 at once but only 6 an hour could fill 6 slots and
    // wait, which reads as a broken concurrency limit to whoever set it.
    const policy = workerPolicyFor(
      local({ concurrency: 2, maxPerHour: 6, small: { enabled: true, maxWorkers: 20 } }),
    );
    assert.ok(policy.maxPerHour >= policy.concurrency);
  });

  it("keeps the configured hourly cap when it is already large enough", () => {
    // maxPerHour's default is unchanged; this only raises it when it would
    // otherwise contradict the concurrency in force.
    const policy = workerPolicyFor(
      local({ concurrency: 20, maxPerHour: 60, small: { enabled: true, maxWorkers: 3 } }),
    );
    assert.equal(policy.maxPerHour, 60);
    assert.equal(policy.concurrency, 3);
  });
});
