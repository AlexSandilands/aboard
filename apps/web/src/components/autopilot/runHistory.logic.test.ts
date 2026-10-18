import { describe, expect, it } from "vitest";
import {
  deleteTitle,
  describeRunFilter,
  isNarrowed,
  keptText,
  localDayStart,
  runHistoryFilter,
  runHistoryParams,
  RunHistorySearch,
  runsOfPages,
} from "./runHistory.logic";

const now = new Date("2026-03-10T12:00:00.000Z");

describe("RunHistorySearch", () => {
  it("keeps good params and drops bad ones", () => {
    expect(RunHistorySearch.parse({ project: "p1", range: "7d", q: "x" })).toEqual({
      project: "p1",
      range: "7d",
      q: "x",
    });
    expect(RunHistorySearch.parse({ range: "forever", since: "yesterday", until: "2026-13-45", project: "" })).toEqual(
      {},
    );
    expect(RunHistorySearch.parse({ range: "custom", since: "2026-03-01", until: "2026-03-05" })).toEqual({
      range: "custom",
      since: "2026-03-01",
      until: "2026-03-05",
    });
  });
});

describe("runHistoryFilter", () => {
  it("is just the automation by default", () => {
    expect(runHistoryFilter("orchestrate", {}, now)).toEqual({ automation: "orchestrate" });
  });

  it("turns a preset into a since an interval ago", () => {
    expect(runHistoryFilter("all", { range: "24h" }, now).since).toBe("2026-03-09T12:00:00.000Z");
    expect(runHistoryFilter("all", { range: "7d" }, now).since).toBe("2026-03-03T12:00:00.000Z");
    expect(runHistoryFilter("all", { range: "30d" }, now).since).toBe("2026-02-08T12:00:00.000Z");
  });

  it("takes a custom range as whole local days, the last one included", () => {
    const filter = runHistoryFilter("all", { range: "custom", since: "2026-03-01", until: "2026-03-05" }, now);
    expect(filter.since).toBe(new Date(2026, 2, 1).toISOString());
    expect(filter.until).toBe(new Date(2026, 2, 6).toISOString());
    expect(runHistoryFilter("all", { range: "custom", until: "2026-03-05" }, now).since).toBeUndefined();
  });

  it("ignores since and until outside a custom range", () => {
    expect(runHistoryFilter("all", { since: "2026-03-01", until: "2026-03-05" }, now)).toEqual({ automation: "all" });
  });

  it("carries the project, and the search trimmed unless it is blank", () => {
    expect(runHistoryFilter("all", { project: "p1", q: "  flaky  " }, now)).toEqual({
      automation: "all",
      projectId: "p1",
      q: "flaky",
    });
    expect(runHistoryFilter("all", { q: "   " }, now)).toEqual({ automation: "all" });
  });
});

describe("localDayStart", () => {
  it("rolls over month ends", () => {
    expect(localDayStart("2026-01-31", 1)).toBe(new Date(2026, 1, 1).toISOString());
  });
});

describe("runHistoryParams", () => {
  it("lists the filter's parts and the cursor, and nothing else", () => {
    const params = runHistoryParams({ automation: "orchestrate", projectId: "p1", q: "a b" }, "abc");
    expect(Object.fromEntries(params)).toEqual({ automation: "orchestrate", projectId: "p1", q: "a b", cursor: "abc" });
    expect(Object.fromEntries(runHistoryParams({ automation: "all" }))).toEqual({ automation: "all" });
  });
});

describe("runsOfPages", () => {
  it("joins the pages and keeps each run once", () => {
    const pages = [{ runs: [{ id: "a" }, { id: "b" }] }, { runs: [{ id: "b" }, { id: "c" }] }];
    expect(runsOfPages(pages).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(runsOfPages(undefined)).toEqual([]);
  });
});

describe("filter text", () => {
  it("says whether anything narrows the list", () => {
    expect(isNarrowed({})).toBe(false);
    expect(isNarrowed({ q: "  " })).toBe(false);
    expect(isNarrowed({ range: "7d" })).toBe(true);
    expect(isNarrowed({ project: "p1" })).toBe(true);
  });

  it("describes what a delete-all would act on", () => {
    expect(describeRunFilter("Orchestrate", null, {})).toBe("Orchestrate runs");
    expect(describeRunFilter(null, "Alpha", { range: "30d", q: "x" })).toBe(
      "Runs of every automation in Alpha from the last 30 days matching “x”",
    );
    expect(describeRunFilter("Orchestrate", null, { range: "custom", until: "2026-03-05" })).toBe(
      "Orchestrate runs until 2026-03-05",
    );
  });

  it("says why runs are kept, and titles the dialog", () => {
    expect(
      keptText({
        keptReasons: [
          { reason: "active", count: 1 },
          { reason: "recent", count: 3 },
        ],
      }),
    ).toBe("1 still queued or running; 3 less than a day old");
    expect(deleteTitle(1)).toBe("Delete 1 run?");
    expect(deleteTitle(12)).toBe("Delete 12 runs?");
  });
});
