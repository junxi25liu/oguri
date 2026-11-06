/**
 * Capacity shared by every worker process on one oguri home.
 *
 * Each `Worker` keeps its own `RunBudget`, so two processes on one home (a
 * `worker start` beside a `superagent start`, or a service restarted while the
 * old process drains) would each admit `concurrency` runs. These tests start
 * real worker processes against one home and count the runs live at once.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import { HomeSlots } from "../src/home-slots.ts";

const FIXTURE = new URL("./fixtures/home-worker.ts", import.meta.url).pathname;

let root: string;
const children: ChildProcess[] = [];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "oguri-home-slots-"));
});
after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
});

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `01J${prefix}${String(i).padStart(22, "0")}`);
}

interface Spawned {
  child: ChildProcess;
  exited: Promise<number | null>;
  stderr: () => string;
}

function launch(
  dir: string,
  options: { tasks: string[]; concurrency: number; holdMs: string; startAt?: number },
): Spawned {
  const child = spawn(process.execPath, [FIXTURE], {
    env: {
      ...process.env,
      FIX_HOME: join(dir, "home"),
      FIX_LIVE: join(dir, "live"),
      FIX_PEAK: join(dir, "peak"),
      FIX_TASKS: options.tasks.join(","),
      FIX_CONCURRENCY: String(options.concurrency),
      FIX_HOLD_MS: options.holdMs,
      FIX_START_AT: String(options.startAt ?? 0),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exited, stderr: () => stderr };
}

async function peaks(dir: string): Promise<number[]> {
  try {
    return (await readFile(join(dir, "peak"), "utf8")).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function until(condition: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(25);
  }
}

describe("capacity shared by worker processes on one home", () => {
  it("two processes started together never exceed the concurrency limit", async () => {
    const dir = await mkdtemp(join(root, "together-"));
    await mkdir(join(dir, "live"), { recursive: true });
    const startAt = Date.now() + 1_500;
    const a = launch(dir, { tasks: ids("A", 4), concurrency: 2, holdMs: "400", startAt });
    const b = launch(dir, { tasks: ids("B", 4), concurrency: 2, holdMs: "400", startAt });
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    assert.deepEqual([codeA, codeB], [0, 0], `${a.stderr()}${b.stderr()}`);

    const seen = await peaks(dir);
    assert.equal(seen.length, 8, "every offered task ran");
    assert.equal(Math.max(...seen), 2, `live runs at each start: ${seen.join(",")}`);
    assert.deepEqual(await readdir(join(dir, "home", "slots")), [], "every lease was released");
  });

  it("a crashed process gives its slots back to the survivor", async () => {
    const dir = await mkdtemp(join(root, "crash-"));
    await mkdir(join(dir, "live"), { recursive: true });
    const a = launch(dir, { tasks: ids("C", 2), concurrency: 2, holdMs: "forever" });
    await until(async () => (await peaks(dir)).length === 2);

    const b = launch(dir, { tasks: ids("D", 2), concurrency: 2, holdMs: "100" });
    await sleep(1_500);
    assert.equal((await peaks(dir)).length, 2, "B starts nothing while A holds both slots");

    a.child.kill("SIGKILL");
    await a.exited;
    assert.equal(await b.exited, 0, b.stderr());
    const seen = await peaks(dir);
    assert.equal(seen.length, 4, "B ran both its tasks once A's slots were reclaimed");
    assert.ok(Math.max(...seen) <= 2, `live runs at each start: ${seen.join(",")}`);
  });

  it("a single process behaves as before", async () => {
    const dir = await mkdtemp(join(root, "single-"));
    await mkdir(join(dir, "live"), { recursive: true });
    const a = launch(dir, { tasks: ids("S", 5), concurrency: 2, holdMs: "300" });
    assert.equal(await a.exited, 0, a.stderr());
    const seen = await peaks(dir);
    assert.equal(seen.length, 5);
    assert.equal(Math.max(...seen), 2, `live runs at each start: ${seen.join(",")}`);
  });
});

describe("HomeSlots", () => {
  it("keeps the follow-up slot for follow-ups and counts leases across instances", async () => {
    const home = await mkdtemp(join(root, "unit-"));
    const one = new HomeSlots(home);
    const two = new HomeSlots(home);
    const limits = { concurrency: 2 };

    const first = await one.reserve(limits, false);
    const second = await two.reserve(limits, false);
    assert.ok("lease" in first && "lease" in second);
    const third = await one.reserve(limits, false);
    assert.ok("blocker" in third, "new work cannot take a third slot");
    assert.match(third.blocker, /all 2 run slot\(s\) are busy/);

    const followup = await two.reserve(limits, true);
    assert.ok("lease" in followup, "the reserved slot takes a follow-up");
    const another = await one.reserve(limits, true);
    assert.ok("blocker" in another, "and only one");

    await followup.lease.release();
    await first.lease.release();
    await first.lease.release();
    const after = await two.reserve(limits, false);
    assert.ok("lease" in after, "a released slot is free for the other instance");
    await after.lease.release();
    await second.lease.release();
    assert.deepEqual(await readdir(join(home, "slots")), []);
  });
});
