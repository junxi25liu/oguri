import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { processStartTime, sameProcessAlive } from "../src/process.ts";

describe("current-process identity without external inspection", () => {
  it("knows its own start time from uptime", async () => {
    const expected = Date.now() - process.uptime() * 1_000;
    const actual = await processStartTime(process.pid);
    assert.notEqual(actual, null);
    assert.ok(Math.abs((actual as number) - expected) < 2_000);
  });

  it("keeps a current run alive", async () => {
    assert.equal(await sameProcessAlive(process.pid, Date.now()), true);
  });

  it("does not attribute an older record to a reused current pid", async () => {
    const started = (await processStartTime(process.pid)) as number;
    assert.equal(await sameProcessAlive(process.pid, started - 3_600_000), false);
  });
});
