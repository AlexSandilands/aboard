import { describe, expect, it } from "vitest";
import { dueDateLabel, dueStateOf, localToday } from "./dueDate.logic";

describe("localToday", () => {
  it("is the local calendar date, zero-padded", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localToday(new Date(2026, 11, 31, 0, 1))).toBe("2026-12-31");
  });

  it("rolls over month and year at local midnight", () => {
    expect(localToday(new Date(2026, 1, 28, 12))).toBe("2026-02-28");
    expect(localToday(new Date(2027, 0, 1, 0, 0))).toBe("2027-01-01");
  });
});

describe("dueStateOf", () => {
  it("is overdue before today, today on it and later after, across edges", () => {
    expect(dueStateOf("2026-12-31", "2027-01-01")).toBe("overdue");
    expect(dueStateOf("2027-01-01", "2027-01-01")).toBe("today");
    expect(dueStateOf("2026-03-01", "2026-02-28")).toBe("later");
  });
});

describe("dueDateLabel", () => {
  it("leaves the year out for this year only", () => {
    expect(dueDateLabel("2026-11-02", "2026-06-01")).not.toContain("2026");
    expect(dueDateLabel("2027-01-03", "2026-12-31")).toContain("2027");
  });
});
