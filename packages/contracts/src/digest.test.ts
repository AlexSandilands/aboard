import { describe, expect, it } from "vitest";
import { dueDigestSlot } from "./digest.ts";

/** Local wall-clock parts, so the assertions read the same in any zone. */
const local = (date: Date | null): string | null =>
  date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : null;

// 2026-10-12 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const daily = { time: "09:00", weekdaysOnly: false };
const weekdays = { time: "09:00", weekdaysOnly: true };
const due = (schedule: typeof daily, now: Date, since: Date) =>
  local(dueDigestSlot(schedule, now, since.toISOString()));

describe("dueDigestSlot", () => {
  it("is due from the slot's time, once, and not for a slot the last digest already covered", () => {
    expect(due(daily, at(12, 8, 59), at(11, 9, 0))).toBeNull();
    expect(due(daily, at(12, 9, 0), at(11, 9, 1))).toBe("2026-10-12 09:00");
    expect(due(daily, at(12, 15, 0), at(12, 9, 1))).toBeNull();
    expect(due(daily, at(13, 9, 0), at(12, 9, 1))).toBe("2026-10-13 09:00");
  });

  it("counts a digest made by hand after the slot as that slot's", () => {
    expect(due(daily, at(12, 10, 0), at(12, 9, 30))).toBeNull();
    expect(due(daily, at(12, 10, 0), at(12, 8, 0))).toBe("2026-10-12 09:00");
  });

  it("makes one catch-up digest for days the board was off, not one per day", () => {
    expect(due(daily, at(15, 12, 0), at(11, 9, 5))).toBe("2026-10-15 09:00");
  });

  it("skips the weekend when asked, and catches up on Monday", () => {
    // 2026-10-17 is a Saturday, 2026-10-19 the next Monday.
    expect(due(weekdays, at(17, 9, 30), at(16, 9, 1))).toBeNull();
    expect(due(weekdays, at(18, 12, 0), at(16, 9, 1))).toBeNull();
    expect(due(weekdays, at(19, 9, 0), at(16, 9, 1))).toBe("2026-10-19 09:00");
    expect(due(daily, at(17, 9, 30), at(16, 9, 1))).toBe("2026-10-17 09:00");
  });

  it("is not due for a slot before the settings last changed", () => {
    // Switched on at 14:00: today's 09:00 is not owed.
    expect(due(daily, at(12, 14, 5), at(12, 14, 0))).toBeNull();
    expect(due(daily, at(13, 9, 0), at(12, 14, 0))).toBe("2026-10-13 09:00");
  });
});
