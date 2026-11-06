/**
 * Run slots shared by every worker process on one oguri home.
 *
 * `RunBudget` counts the runs of one process. Two processes on one home (a
 * `worker start` beside a `superagent start`, or a service restarted while its
 * predecessor drains) would each admit `concurrency` runs, doubling what the
 * policy promised to spend. A slot is therefore an empty lease file under
 * `<home>/slots/`, one per live run, and every process counts them all.
 *
 * The file name carries everything a count needs (`<pid>-<n|f>-<ulid>`: the
 * owner, whether it is a follow-up, and when it was taken), so counting is one
 * directory listing and creating a lease is one `open`. That keeps a pass that
 * admits twenty runs at once fast enough to admit them all while the first is
 * still running.
 *
 * There is no lock to get stuck on. A process creates its lease, lists the
 * directory again, and keeps the lease only if the home is within its limit
 * in that listing; otherwise it withdraws and tries again after a short,
 * random pause. Whichever process lists last sees every lease that is kept,
 * so the kept leases can never outnumber the limit. Two processes racing for
 * the last slot may both withdraw, which costs a retry, never an extra run.
 *
 * A process that dies without releasing leaves a lease nobody can finish, so
 * a lease whose owner is gone is deleted by the next process that counts.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describeError } from "@oguri/core";
import { ulid, ulidTime } from "@oguri/protocol";

import { sameProcessAlive } from "./process.ts";

interface Lease {
  pid: number;
  at: number;
  followup: boolean;
}

export interface SlotLimits {
  concurrency: number;
}

export interface SlotLease {
  /** Give the slot back. Safe to call more than once. */
  release(): Promise<void>;
}

export type Reservation = { lease: SlotLease } | { blocker: string };

const ATTEMPTS = 5;
const NAME = /^(\d+)-([nf])-([0-9A-Z]{26})$/;

export function slotsDir(home: string): string {
  return join(home, "slots");
}

/** `null` when the leases fit the limit, otherwise why they do not. */
function overLimit(leases: readonly Lease[], concurrency: number, followup: boolean) {
  const followups = leases.filter((lease) => lease.followup).length;
  if (followup) {
    return leases.length > concurrency + 1
      ? `all ${String(concurrency)} run slot(s) and the follow-up slot are busy`
      : null;
  }
  return leases.length - Math.min(followups, 1) > concurrency
    ? `all ${String(concurrency)} run slot(s) are busy`
    : null;
}

function parse(name: string): Lease | null {
  const match = NAME.exec(name);
  if (match === null) return null;
  return {
    pid: Number(match[1]),
    at: ulidTime(match[3] as string),
    followup: match[2] === "f",
  };
}

export class HomeSlots {
  private readonly dir: string;

  constructor(home: string) {
    this.dir = slotsDir(home);
  }

  /**
   * Take a slot if the home has one, by the same rule `RunBudget` applies to a
   * single process: one slot beyond `concurrency` is for follow-ups, and new
   * work never uses it.
   */
  async reserve(limits: SlotLimits, followup: boolean): Promise<Reservation> {
    const { concurrency } = limits;
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      let busy: string | null = null;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        // Counting first keeps a full home from writing and withdrawing every pass.
        const mine: Lease = { pid: process.pid, at: 0, followup };
        busy = overLimit([...(await this.live()), mine], concurrency, followup);
        if (busy !== null) return { blocker: busy };

        const path = join(this.dir, `${String(process.pid)}-${followup ? "f" : "n"}-${ulid()}`);
        await writeFile(path, "", { mode: 0o600 });
        busy = overLimit(await this.live(), concurrency, followup);
        if (busy === null) return { lease: this.lease(path) };
        await rm(path, { force: true });
        if (attempt < ATTEMPTS) await sleep(5 + Math.floor(Math.random() * 25 * attempt));
      }
      return { blocker: busy ?? "the run slots on this home are contended" };
    } catch (error) {
      // Not knowing the count must not be read as "free": that is the overflow.
      return {
        blocker: `could not count the run slots in use on this home: ${describeError(error)}`,
      };
    }
  }

  private lease(path: string): SlotLease {
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true });
      },
    };
  }

  /** Leases whose owner is still running; the rest are deleted as debris. */
  private async live(): Promise<Lease[]> {
    const live: Lease[] = [];
    // One liveness answer per owner per count: a worker with many runs is one process.
    const owners = new Map<number, Promise<boolean>>();
    for (const name of await readdir(this.dir)) {
      const lease = parse(name);
      let alive = false;
      if (lease !== null) {
        if (lease.pid === process.pid) alive = true;
        else {
          let answer = owners.get(lease.pid);
          if (answer === undefined) {
            // The oldest lease of an owner bounds when that owner started.
            answer = sameProcessAlive(lease.pid, lease.at);
            owners.set(lease.pid, answer);
          }
          alive = await answer;
        }
      }
      if (lease !== null && alive) live.push(lease);
      else await rm(join(this.dir, name), { force: true });
    }
    return live;
  }
}
