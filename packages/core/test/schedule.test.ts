import { Cron } from "croner";
import { afterEach, describe, expect, it } from "vitest";
import { Scheduler, type Cascade } from "../src/index.js";

const cascade = (schedule: string[], timezone?: string): Cascade => ({ schedule, timezone, onBusy: "skip", steps: [] });

let scheduler: Scheduler | undefined;
afterEach(() => scheduler?.stop());

describe("scheduler", () => {
  it("fires cascades by their schedule, once per moment even if several expressions match", async () => {
    const fired: string[] = [];
    scheduler = new Scheduler((name) => fired.push(name));
    scheduler.update({
      every: cascade(["* * * * * *", "*/1 * * * * *"]),
      manual: cascade([]),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fired)).toEqual(new Set(["every"]));
    // at most one fire per second
    expect(fired.length).toBeLessThanOrEqual(2);
    expect(scheduler.nextRun("manual")).toBeUndefined();
  });

  it("replaces schedules on update", async () => {
    const fired: string[] = [];
    scheduler = new Scheduler((name) => fired.push(name));
    scheduler.update({ every: cascade(["* * * * * *"]) });
    scheduler.update({ yearly: cascade(["0 0 1 1 *"]) });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(fired).toEqual([]);
    expect(scheduler.nextRun("every")).toBeUndefined();
  });

  it("reports the earliest next run, in the cascade's time zone", () => {
    scheduler = new Scheduler(() => {});
    scheduler.update({ c: cascade(["0 3 * * *", "0 1 * * *"], "Asia/Tokyo") });
    const next = scheduler.nextRun("c")!;
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(next);
    expect([1, 3]).toContain(Number(hour));
    const each = ["0 3 * * *", "0 1 * * *"].map((e) => new Cron(e, { timezone: "Asia/Tokyo", paused: true }).nextRun()!);
    expect(next.getTime()).toBe(Math.min(...each.map((d) => d.getTime())));
  });
});
