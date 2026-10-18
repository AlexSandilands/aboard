import { describe, expect, it } from "vitest";
import {
  axisLabelIndices,
  bucketLabel,
  bucketTitle,
  periodLabel,
  previousPeriodLabel,
  breakdownRows,
  changeVsPrevious,
  formatDuration,
  formatStatsValue,
  isQuiet,
  niceDurationScale,
  niceScale,
  parseStatsPeriod,
  runsByAutomation,
  runsByStatusWeekly,
  runsInStatuses,
} from "./stats.logic";

describe("niceScale", () => {
  it("rounds the top up to a round step", () => {
    expect(niceScale(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(niceScale(23).max).toBe(30);
  });
  it("keeps an axis for an all-zero series", () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
  it("keeps whole-number ticks for counts", () => {
    expect(niceScale(1, 4, true).ticks).toEqual([0, 1]);
    expect(niceScale(2, 4, true).ticks).toEqual([0, 1, 2]);
    expect(niceScale(3, 4, true).ticks).toEqual([0, 1, 2, 3]);
    for (const max of [1, 2, 3, 4, 5, 7, 11]) {
      const { ticks } = niceScale(max, 4, true);
      expect(ticks.every(Number.isInteger)).toBe(true);
    }
  });
  it("has no float drift on fractions", () => {
    expect(niceScale(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });
  it("always includes the maximum under the top", () => {
    for (const max of [1, 3, 9, 14, 99, 1234]) {
      const scale = niceScale(max);
      expect(scale.max).toBeGreaterThanOrEqual(max);
      expect(scale.ticks.at(-1)).toBe(scale.max);
    }
  });
});

describe("niceDurationScale", () => {
  const H = 3_600_000;
  const D = 24 * H;
  it("ticks on hours and days", () => {
    expect(niceDurationScale(5 * H).ticks).toEqual([0, 2 * H, 4 * H, 6 * H]);
    expect(niceDurationScale(4.2 * D).ticks).toEqual([0, 2 * D, 4 * D, 6 * D]);
  });
  it("covers the maximum, and keeps an axis for none", () => {
    expect(niceDurationScale(100 * D).max).toBeGreaterThanOrEqual(100 * D);
    expect(niceDurationScale(0).ticks).toEqual([0, 60_000]);
  });
});

describe("formatDuration", () => {
  it("uses the two leading units", () => {
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(3 * 3_600_000 + 20 * 60_000)).toBe("3h 20m");
    expect(formatDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
  });
  it("drops an empty small unit and carries a rounded-up one", () => {
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
    expect(formatDuration(3_600_000 - 20_000)).toBe("1h");
    expect(formatDuration(86_400_000 - 60_000 * 10)).toBe("23h 50m");
  });
});

describe("formatStatsValue", () => {
  it("formats by unit", () => {
    expect(formatStatsValue(null, "count")).toBe("–");
    expect(formatStatsValue(1234, "count")).toBe("1,234");
    expect(formatStatsValue(1.25, "usd")).toBe("$1.25");
    expect(formatStatsValue(1250, "usd")).toBe("$1,250");
    expect(formatStatsValue(1.5, "ratio")).toBe("1.5");
    expect(formatStatsValue(0.05, "ratio")).toBe("0.05");
    expect(formatStatsValue(0, "ratio")).toBe("0");
    expect(formatStatsValue(12.4, "ratio")).toBe("12");
    expect(formatStatsValue(5_400_000, "ms")).toBe("1h 30m");
  });
});

describe("changeVsPrevious", () => {
  it("is a signed percentage", () => {
    expect(changeVsPrevious(12, 10)).toEqual({
      label: "+20%",
      direction: "up",
    });
    expect(changeVsPrevious(8, 10)).toEqual({
      label: "−20%",
      direction: "down",
    });
  });
  it("handles an empty previous period", () => {
    expect(changeVsPrevious(3, 0)).toEqual({ label: "new", direction: "up" });
    expect(changeVsPrevious(0, 0)).toEqual({
      label: "no change",
      direction: "flat",
    });
  });
  it("has nothing to compare when a side has no value", () => {
    expect(changeVsPrevious(null, 5)).toBeNull();
    expect(changeVsPrevious(5, null)).toBeNull();
  });
  it("reads a change that rounds to zero as flat", () => {
    expect(changeVsPrevious(1001, 1000)).toEqual({
      label: "no change",
      direction: "flat",
    });
  });
});

describe("axisLabelIndices", () => {
  it("labels every week when there are few", () => {
    expect(axisLabelIndices(4)).toEqual([0, 1, 2, 3]);
  });
  it("spreads labels and keeps the last bucket", () => {
    const indices = axisLabelIndices(52);
    expect(indices.at(-1)).toBe(51);
    expect(indices.length).toBeLessThanOrEqual(7);
  });
});

describe("day buckets", () => {
  // Local midnight on Monday 2026-10-12, as the server sends a day's start.
  const monday = { start: new Date(2026, 9, 12).toISOString(), end: new Date(2026, 9, 13).toISOString() };

  it("labels a day by its weekday and date, and a week by its start", () => {
    expect(bucketLabel(monday, "day")).toBe("Mon 12");
    expect(bucketLabel(monday)).toBe("Oct 12");
  });

  it("titles a bucket for the tooltip, marking the current one", () => {
    expect(bucketTitle(monday, 0, 7, "day")).toBe("Mon, Oct 12");
    expect(bucketTitle(monday, 6, 7, "day")).toBe("Mon, Oct 12 (so far)");
    expect(bucketTitle(monday, 3, 12, "week")).toBe("Week of Oct 12");
  });

  it("labels every day of a 7-day chart when asked to", () => {
    expect(axisLabelIndices(7, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("names the period and what it is compared with", () => {
    expect(previousPeriodLabel({ bucket: "day", weeks: 1 })).toBe("previous week");
    expect(previousPeriodLabel({ bucket: "week", weeks: 12 })).toBe("previous 12 weeks");
    expect(periodLabel({ bucket: "day", weeks: 1 })).toBe("the last 7 days");
    expect(periodLabel({ bucket: "week", weeks: 4 })).toBe("the last 4 weeks");
  });
});

describe("parseStatsPeriod", () => {
  it("accepts the API's periods and defaults otherwise", () => {
    expect(parseStatsPeriod("1")).toBe(1);
    expect(parseStatsPeriod("4")).toBe(4);
    expect(parseStatsPeriod(52)).toBe(52);
    expect(parseStatsPeriod("7")).toBe(12);
    expect(parseStatsPeriod(undefined)).toBe(12);
  });
});

describe("runs by automation", () => {
  const series = {
    "autopilot.runs": {
      unit: "count" as const,
      values: [3, 1],
      total: 4,
      previousTotal: 0,
    },
    "autopilot.runs.review_prs.succeeded": {
      unit: "count" as const,
      values: [2, 1],
      total: 3,
      previousTotal: 0,
    },
    "autopilot.runs.review_prs.failed": {
      unit: "count" as const,
      values: [1, 0],
      total: 1,
      previousTotal: 0,
    },
    "autopilot.runs.custom.a.b.succeeded": {
      unit: "count" as const,
      values: [0, 5],
      total: 5,
      previousTotal: 0,
    },
  };
  it("groups by automation, busiest first, splitting on the last dot", () => {
    expect(runsByAutomation(series)).toEqual([
      { automation: "custom.a.b", byStatus: { succeeded: 5 }, total: 5 },
      {
        automation: "review_prs",
        byStatus: { succeeded: 3, failed: 1 },
        total: 4,
      },
    ]);
  });
  it("sums a status across automations by week", () => {
    expect(runsByStatusWeekly(series, ["succeeded"], 2)).toEqual([2, 6]);
    expect(runsByStatusWeekly(series, ["failed"], 2)).toEqual([1, 0]);
  });
  it("groups queued and running runs as in progress, so columns add up to the total", () => {
    const withActive = {
      ...series,
      "autopilot.runs.review_prs.running": { unit: "count" as const, values: [0, 2], total: 2, previousTotal: 0 },
      "autopilot.runs.review_prs.queued": { unit: "count" as const, values: [0, 1], total: 1, previousTotal: 0 },
    };
    expect(runsByStatusWeekly(withActive, ["queued", "running"], 2)).toEqual([0, 3]);
    const row = runsByAutomation(withActive).find((r) => r.automation === "review_prs")!;
    expect(runsInStatuses(row, ["queued", "running"])).toBe(3);
    expect(
      runsInStatuses(row, ["succeeded"]) + runsInStatuses(row, ["failed"]) + runsInStatuses(row, ["queued", "running"]),
    ).toBe(row.total);
  });
});

describe("breakdownRows", () => {
  const item = (key: string | null, total: number, previousTotal = 0) => ({ key, total, previousTotal });
  const name = (key: string) => key.toUpperCase();

  it("keeps what has something in the period, largest first, and names the none category", () => {
    const rows = breakdownRows(
      { unit: "count", items: [item("a", 1, 4), item(null, 3), item("b", 0, 2), item("c", 3)] },
      name,
      "None",
    );
    expect(rows.map((r) => [r.label, r.value, r.previous])).toEqual([
      ["C", 3, 0],
      ["None", 3, 0],
      ["A", 1, 4],
    ]);
  });

  it("folds the tail past the limit into one Other row that adds up", () => {
    const items = ["a", "b", "c", "d", "e"].map((key, i) => item(key, 5 - i, 1));
    const rows = breakdownRows({ unit: "count", items }, name, "None", 3);
    expect(rows.map((r) => [r.label, r.value, r.previous])).toEqual([
      ["A", 5, 1],
      ["B", 4, 1],
      ["Other (3)", 6, 3],
    ]);
  });

  it("is empty without a breakdown", () => {
    expect(breakdownRows(undefined, name, "None")).toEqual([]);
  });
});

describe("isQuiet", () => {
  const level = { unit: "count" as const, values: [3, 3], total: 3, previousTotal: 2 };
  const none = { unit: "count" as const, values: [0, 0], total: 0, previousTotal: 0 };
  it("doesn't count tasks sitting open as something happening", () => {
    expect(isQuiet({ "open_tasks.backlog": level, tasks_created: none })).toBe(true);
  });
  it("is not quiet once anything else has a value", () => {
    expect(isQuiet({ "open_tasks.backlog": level, tasks_created: { ...none, total: 1 } })).toBe(false);
  });
});
