/**
 * How many runs may start, now and this hour.
 *
 * Runs spend money on someone's agent plan, so both limits are hard: a slot
 * that is not free is not borrowed, and an hour that is spent is not extended.
 *
 * One slot beyond `concurrency` is reserved for follow-ups (ADR 0030 §5): a
 * person waiting in a chat for an answer should not wait for the backlog. New
 * work never uses that slot, and follow-ups still count against the hour.
 */

const HOUR_MS = 60 * 60_000;

export interface BudgetLimits {
  concurrency: number;
  maxPerHour: number;
}

export class RunBudget {
  private readonly starts: number[] = [];
  private active = 0;
  private followups = 0;
  private readonly limits: () => BudgetLimits;
  private readonly now: () => number;

  /** `limits` is read on every check, so a policy edit takes effect on the next run. */
  constructor(limits: () => BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  /** `null` when a run may start, otherwise the reason it may not. */
  blocker(followup = false): string | null {
    const { concurrency, maxPerHour } = this.limits();
    if (followup) {
      if (this.active >= concurrency + 1) {
        return `all ${String(concurrency)} run slot(s) and the follow-up slot are busy`;
      }
    } else if (this.active - Math.min(this.followups, 1) >= concurrency) {
      return `all ${String(concurrency)} run slot(s) are busy`;
    }
    if (this.startedThisHour() >= maxPerHour) {
      return `hourly limit of ${String(maxPerHour)} run(s) reached`;
    }
    return null;
  }

  /**
   * Count runs that started before this process did.
   *
   * The hourly cap is a promise about spending, and a restart must not reset
   * it: a worker that crashes and is restarted by its service every minute
   * would otherwise start a fresh hour each time.
   */
  seed(startedAt: readonly number[]): void {
    const cutoff = this.now() - HOUR_MS;
    this.starts.push(...startedAt.filter((at) => at > cutoff));
    this.starts.sort((a, b) => a - b);
  }

  start(followup = false): void {
    this.active += 1;
    if (followup) this.followups += 1;
    this.starts.push(this.now());
  }

  finish(followup = false): void {
    this.active = Math.max(0, this.active - 1);
    if (followup) this.followups = Math.max(0, this.followups - 1);
  }

  get running(): number {
    return this.active;
  }

  startedThisHour(): number {
    const cutoff = this.now() - HOUR_MS;
    while (this.starts.length > 0 && (this.starts[0] as number) <= cutoff) this.starts.shift();
    return this.starts.length;
  }
}
