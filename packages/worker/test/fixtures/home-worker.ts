/**
 * One worker process for the shared-home capacity tests (home-slots.test.ts).
 *
 * Runs a real `Worker` over a fake backend whose executor records, in a
 * directory every process shares, which runs are live. Its configuration comes
 * from the environment so the test can start several of these at once:
 *
 *   FIX_HOME     the oguri home all processes share
 *   FIX_LIVE     directory of live-run markers, shared by all processes
 *   FIX_PEAK     file each process appends the live count it saw at each start to
 *   FIX_TASKS    comma-separated task ids this process is offered
 *   FIX_CONCURRENCY  worker.concurrency
 *   FIX_HOLD_MS  how long a run lasts; "forever" holds until the process is killed
 *   FIX_START_AT wall-clock ms to begin at, so processes start together
 */

import { appendFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_WORKER_POLICY, type Agenda } from "@oguri/core";
import type { Backend } from "@oguri/daemon";

import { Worker } from "../../src/worker.ts";

const env = (name: string): string => process.env[name] ?? "";
const home = env("FIX_HOME");
const live = env("FIX_LIVE");
const peak = env("FIX_PEAK");
const tasks = env("FIX_TASKS").split(",").filter(Boolean);
const concurrency = Number(env("FIX_CONCURRENCY") || "1");
const holdMs = env("FIX_HOLD_MS");
const startAt = Number(env("FIX_START_AT") || "0");
const ME = "bob-claude";

const claimed = new Set<string>();
const finished = new Set<string>();

const agenda = (): Agenda =>
  ({
    entries: tasks
      .filter((id) => !claimed.has(id))
      .map((id) => ({
        room: "ops",
        relation: "offered",
        inFlight: false,
        needsAttention: false,
        ready: true,
        status: {
          task: { id, title: `task ${id.slice(-3)}`, creator: "alice-claude", state: "open" },
          definition: "Hold a slot.",
          waitingOn: [],
          children: [],
        },
      })),
    counts: {},
    inFlightThreads: [],
  }) as unknown as Agenda;

const backend: Backend = {
  mode: "direct",
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case "agenda":
        return agenda() as T;
      case "taskClaim":
        claimed.add(params["taskId"] as string);
        return { header: { task: { attempt: 1 } } } as T;
      case "taskShow":
        return {
          task: {
            id: params["taskId"],
            title: "t",
            creator: "alice-claude",
            state: "in_progress",
            assignee: ME,
            action: "progressed",
            staleAfterSeconds: 86400,
          },
          events: [],
        } as T;
      default:
        return {} as T;
    }
  },
  async networks() {
    return [];
  },
  async close() {},
};

const worker = new Worker({
  backend,
  agentId: ME,
  home,
  loadPolicy: async () => ({
    ...DEFAULT_WORKER_POLICY,
    enabled: true,
    concurrency,
    maxPerHour: 1000,
    runners: { claude: { argv: ["claude", "-p"], worktree: false } },
    trustedRequesters: [],
    capabilities: [],
  }),
  executor: async (request) => {
    // logDir is <home>/runs/<taskId>/<runId>
    const id = basename(dirname(request.logDir));
    await mkdir(live, { recursive: true });
    await writeFile(join(live, `${String(process.pid)}-${id}`), "");
    // A killed process leaves its markers behind; only live processes count.
    const alive = (await readdir(live)).filter((name) => {
      try {
        process.kill(Number(name.split("-")[0]), 0);
        return true;
      } catch {
        return false;
      }
    });
    await appendFile(peak, `${String(alive.length)}\n`);
    if (holdMs === "forever") await sleep(10 * 60_000);
    else await sleep(Number(holdMs));
    await rm(join(live, `${String(process.pid)}-${id}`), { force: true });
    finished.add(id);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      stdoutTail: "done",
    };
  },
});

await sleep(Math.max(0, startAt - Date.now()));
const deadline = Date.now() + 60_000;
while (finished.size < tasks.length && Date.now() < deadline) {
  await worker.pass();
  await sleep(25);
}
await worker.idle();
