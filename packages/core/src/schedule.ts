import { Cron } from "croner";
import type { Config } from "./config/types.js";

/**
 * Fires cascades by their `schedule`. Missed times (the daemon was down, the machine slept) are not caught up.
 */
export class Scheduler {
  private jobs = new Map<string, Cron[]>();
  private readonly lastFired = new Map<string, number>();

  constructor(private readonly onFire: (cascade: string) => void) {}

  /** Replaces all schedules with the ones in `cascades`. */
  update(cascades: Config["cascades"]): void {
    this.stop();
    for (const [name, cascade] of Object.entries(cascades)) {
      if (cascade.schedule.length === 0) continue;
      const jobs = cascade.schedule.map((expr) => new Cron(expr, { timezone: cascade.timezone }, () => this.fire(name)));
      this.jobs.set(name, jobs);
    }
  }

  /** The next time the cascade fires, if it has a schedule. */
  nextRun(cascade: string): Date | undefined {
    const times = (this.jobs.get(cascade) ?? []).flatMap((job) => job.nextRun() ?? []);
    return times.sort((a, b) => a.getTime() - b.getTime())[0];
  }

  stop(): void {
    for (const jobs of this.jobs.values()) for (const job of jobs) job.stop();
    this.jobs = new Map();
  }

  private fire(cascade: string): void {
    // several expressions may match the same moment; that is one run, not a run plus skipped duplicates
    const second = Math.floor(Date.now() / 1000);
    if (this.lastFired.get(cascade) === second) return;
    this.lastFired.set(cascade, second);
    this.onFire(cascade);
  }
}
