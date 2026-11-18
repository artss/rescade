import { describe, expect, it } from "vitest";
import { formatTime } from "../src/output.js";

describe("formatTime", () => {
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const at = (d: number, h: number, m: number, s: number) => new Date(2026, 10, d, h, m, s).getTime();

  it("names today, yesterday and tomorrow by calendar day", () => {
    expect(formatTime(at(18, 0, 0, 0), now)).toBe("today at 00:00:00");
    expect(formatTime(at(17, 23, 59, 59), now)).toBe("yesterday at 23:59:59");
    expect(formatTime(at(19, 3, 5, 7), now)).toBe("tomorrow at 03:05:07");
  });

  it("writes other days as dd MMM yyyy", () => {
    expect(formatTime(at(16, 18, 30, 5), now)).toBe("16 Nov 2026 at 18:30:05");
    expect(formatTime(new Date(2027, 0, 2, 9, 0, 0).getTime(), now)).toBe("02 Jan 2027 at 09:00:00");
  });
});
