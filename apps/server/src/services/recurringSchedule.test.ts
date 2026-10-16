import { afterEach, describe, expect, it } from "vitest";
import {
  CreateRecurringRuleInput,
  RecurringSchedule,
  describeSchedule,
  latestDue,
  nextDue,
  type RecurringSchedule as Schedule,
} from "@repo/contracts";

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** Local wall-clock parts, so the assertions read the same in any zone. */
const local = (date: Date | null): string | null =>
  date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : null;

const mondays: Schedule = { kind: "weekly", days: [1], time: "09:00" };

describe("nextDue", () => {
  it("finds the next chosen weekday, and the same day while its time is still ahead", () => {
    // 2026-10-16 is a Friday.
    expect(local(nextDue(mondays, new Date(2026, 9, 16, 12, 0)))).toBe("2026-10-19 09:00");
    expect(local(nextDue(mondays, new Date(2026, 9, 19, 8, 59)))).toBe("2026-10-19 09:00");
    expect(local(nextDue(mondays, new Date(2026, 9, 19, 9, 0)))).toBe("2026-10-26 09:00");
  });

  it("takes the earliest of several weekdays", () => {
    const schedule: Schedule = { kind: "weekly", days: [5, 1], time: "17:30" };
    expect(local(nextDue(schedule, new Date(2026, 9, 16, 18, 0)))).toBe("2026-10-19 17:30");
    expect(local(nextDue(schedule, new Date(2026, 9, 19, 18, 0)))).toBe("2026-10-23 17:30");
  });

  it("counts an interval from its start date", () => {
    const schedule: Schedule = { kind: "every", everyDays: 14, startDate: "2026-10-01", time: "06:00" };
    expect(local(nextDue(schedule, new Date(2026, 9, 1, 5, 0)))).toBe("2026-10-01 06:00");
    expect(local(nextDue(schedule, new Date(2026, 9, 1, 6, 0)))).toBe("2026-10-15 06:00");
    expect(local(nextDue(schedule, new Date(2026, 9, 20, 0, 0)))).toBe("2026-10-29 06:00");
  });

  it("starts an interval no earlier than its start date", () => {
    const schedule: Schedule = { kind: "every", everyDays: 3, startDate: "2027-01-10", time: "06:00" };
    expect(local(nextDue(schedule, new Date(2026, 9, 1, 0, 0)))).toBe("2027-01-10 06:00");
  });
});

describe("latestDue", () => {
  it("is null before the first slot after the cursor", () => {
    const after = new Date(2026, 9, 16, 12, 0);
    expect(latestDue(mondays, new Date(2026, 9, 19, 8, 59), after)).toBeNull();
    expect(local(latestDue(mondays, new Date(2026, 9, 19, 9, 0), after))).toBe("2026-10-19 09:00");
  });

  it("returns only the latest of several missed slots", () => {
    const after = new Date(2026, 8, 25, 12, 0);
    // Mondays Sep 28, Oct 5, Oct 12 and Oct 19 all passed; one catch-up for the last.
    expect(local(latestDue(mondays, new Date(2026, 9, 20, 10, 0), after))).toBe("2026-10-19 09:00");
  });

  it("doesn't return a slot at or before the cursor", () => {
    const after = new Date(2026, 9, 19, 9, 0);
    expect(latestDue(mondays, new Date(2026, 9, 19, 23, 0), after)).toBeNull();
  });

  it("handles an interval after a long downtime", () => {
    const schedule: Schedule = { kind: "every", everyDays: 10, startDate: "2026-01-01", time: "12:00" };
    expect(local(latestDue(schedule, new Date(2026, 9, 16, 13, 0), new Date(2026, 2, 1, 0, 0)))).toBe(
      "2026-10-08 12:00",
    );
  });
});

describe("across DST changes", () => {
  it("keeps the wall-clock time over a spring-forward night (Europe/London, 2026-03-29)", () => {
    process.env.TZ = "Europe/London";
    const daily: Schedule = { kind: "every", everyDays: 1, startDate: "2026-03-01", time: "09:00" };
    expect(local(nextDue(daily, new Date(2026, 2, 28, 9, 0)))).toBe("2026-03-29 09:00");
    expect(local(nextDue(daily, new Date(2026, 2, 29, 9, 0)))).toBe("2026-03-30 09:00");
    // 09:00 on the 28th (GMT) to 09:00 on the 29th (BST) is 23 hours: the slot follows the clock, not 24h steps.
    const from = new Date(2026, 2, 28, 9, 0);
    expect((nextDue(daily, from)!.getTime() - from.getTime()) / 3_600_000).toBe(23);
  });

  it("keeps the wall-clock time over a fall-back night (Europe/London, 2026-10-25)", () => {
    process.env.TZ = "Europe/London";
    const daily: Schedule = { kind: "every", everyDays: 1, startDate: "2026-10-01", time: "09:00" };
    const sunday = nextDue(daily, new Date(2026, 9, 24, 9, 0))!;
    expect(local(sunday)).toBe("2026-10-25 09:00");
    expect(local(nextDue(daily, sunday))).toBe("2026-10-26 09:00");
    // 09:00 on the 24th (BST) to 09:00 on the 25th (GMT) is 25 hours.
    expect((sunday.getTime() - new Date(2026, 9, 24, 9, 0).getTime()) / 3_600_000).toBe(25);
  });

  it("moves a time the clock skips to the hour after, once (America/New_York, 2026-03-08)", () => {
    process.env.TZ = "America/New_York";
    const schedule: Schedule = { kind: "weekly", days: [0], time: "02:30" };
    const slot = nextDue(schedule, new Date(2026, 2, 7, 12, 0))!;
    expect(local(slot)).toBe("2026-03-08 03:30");
    expect(local(nextDue(schedule, slot))).toBe("2026-03-15 02:30");
  });

  it("fires a repeated time once, the first time round (America/New_York, 2026-11-01)", () => {
    process.env.TZ = "America/New_York";
    const schedule: Schedule = { kind: "weekly", days: [0], time: "01:30" };
    const slot = nextDue(schedule, new Date(2026, 10, 1, 0, 0))!;
    expect(local(slot)).toBe("2026-11-01 01:30");
    // The same wall-clock time an hour later is not another slot.
    const later = new Date(slot.getTime() + 3_600_000);
    expect(latestDue(schedule, later, slot)).toBeNull();
    expect(local(nextDue(schedule, slot))).toBe("2026-11-08 01:30");
  });

  it("agrees between nextDue and latestDue on the same slot", () => {
    process.env.TZ = "Europe/London";
    const schedule: Schedule = { kind: "weekly", days: [0], time: "01:30" };
    const after = new Date(2026, 2, 28, 12, 0);
    const slot = nextDue(schedule, after)!;
    expect(latestDue(schedule, slot, after)?.getTime()).toBe(slot.getTime());
  });
});

describe("validation", () => {
  it("sorts and dedupes weekdays", () => {
    expect(RecurringSchedule.parse({ kind: "weekly", days: [5, 1, 5], time: "09:00" })).toEqual({
      kind: "weekly",
      days: [1, 5],
      time: "09:00",
    });
  });

  it("rejects bad times, dates, days and intervals", () => {
    const bad = [
      { kind: "weekly", days: [], time: "09:00" },
      { kind: "weekly", days: [7], time: "09:00" },
      { kind: "weekly", days: [1], time: "9:00" },
      { kind: "weekly", days: [1], time: "24:00" },
      { kind: "every", everyDays: 0, startDate: "2026-10-01", time: "09:00" },
      { kind: "every", everyDays: 400, startDate: "2026-10-01", time: "09:00" },
      { kind: "every", everyDays: 7, startDate: "2026-02-30", time: "09:00" },
      { kind: "every", everyDays: 7, startDate: "10/01/2026", time: "09:00" },
    ];
    for (const schedule of bad) expect(RecurringSchedule.safeParse(schedule).success).toBe(false);
  });

  it("requires a name, a template and a schedule to create a rule", () => {
    expect(CreateRecurringRuleInput.safeParse({ name: "  ", templateId: "t", schedule: mondays }).success).toBe(false);
    expect(CreateRecurringRuleInput.safeParse({ name: "Audit", schedule: mondays }).success).toBe(false);
    expect(CreateRecurringRuleInput.safeParse({ name: "Audit", templateId: "t", schedule: mondays }).success).toBe(
      true,
    );
  });
});

describe("describeSchedule", () => {
  it("reads naturally", () => {
    expect(describeSchedule(mondays)).toBe("Mondays at 09:00");
    expect(describeSchedule({ kind: "weekly", days: [1, 3, 5], time: "08:15" })).toBe(
      "Mondays, Wednesdays and Fridays at 08:15",
    );
    expect(describeSchedule({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "08:15" })).toBe("Every day at 08:15");
    expect(describeSchedule({ kind: "every", everyDays: 14, startDate: "2026-10-01", time: "06:00" })).toBe(
      "Every 14 days at 06:00",
    );
    expect(describeSchedule({ kind: "every", everyDays: 1, startDate: "2026-10-01", time: "06:00" })).toBe(
      "Every day at 06:00",
    );
  });
});
