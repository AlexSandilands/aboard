import { BoardFilterParams, type TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  autopilotChoice,
  clearedParams,
  EMPTY_FILTERS,
  filterParams,
  isEmptyView,
  matchesTaskOwnFilters,
  normalizeParams,
  readFilters,
  sameFilters,
  toggleChoice,
} from "./boardFilters.logic";

const task = (overrides: Partial<TaskSummary> = {}) =>
  ({
    status: "backlog",
    suggestedModel: null,
    autopilot: null,
    blocked: false,
    priority: false,
    ...overrides,
  }) as TaskSummary;

describe("readFilters / filterParams", () => {
  it("round-trips every filter", () => {
    const params: BoardFilterParams = {
      project: "p1",
      epic: "e1",
      labels: "ui,backend",
      status: "planned,review",
      tier: "light,none",
      autopilot: "on,default",
      q: "login",
      attention: true,
      pr: true,
      blocked: true,
      priority: true,
      inprogress: true,
      archived: true,
    };
    expect(filterParams(readFilters(params), params.project)).toEqual(params);
  });

  it("writes lists in the order of their choices, so the same filters make the same URL", () => {
    const filters = readFilters({ status: "done,backlog", tier: "none,deep", autopilot: "default,off,on" });
    expect(filters.statuses).toEqual(["backlog", "done"]);
    expect(filters.tiers).toEqual(["deep", "none"]);
    expect(filters.autopilot).toEqual(["on", "off", "default"]);
  });

  it("drops values it does not know and flags that are not set", () => {
    const filters = readFilters({ status: "review,nonsense", tier: "huge", autopilot: "maybe", q: "  hi  " });
    expect(filters.statuses).toEqual(["review"]);
    expect(filters.tiers).toEqual([]);
    expect(filters.autopilot).toEqual([]);
    expect(filters.text).toBe("hi");
    expect(readFilters({})).toEqual(EMPTY_FILTERS);
  });

  it("leaves unset filters out", () => {
    const params = filterParams(EMPTY_FILTERS);
    expect(Object.values(params).every((value) => value === undefined)).toBe(true);
  });
});

describe("BoardFilterParams", () => {
  it("takes what the router parses a param to: numbers and booleans for text and flags", () => {
    expect(BoardFilterParams.parse({ q: 2024, attention: true, pr: "true" })).toMatchObject({
      q: "2024",
      attention: true,
      pr: true,
    });
  });

  it("ignores a bad value rather than failing the page", () => {
    const parsed = BoardFilterParams.parse({ q: { a: 1 }, attention: "yes", labels: ["a"], status: "done" });
    expect(parsed.q).toBeUndefined();
    expect(parsed.attention).toBeUndefined();
    expect(parsed.labels).toBeUndefined();
    expect(parsed.status).toBe("done");
  });
});

describe("sameFilters / normalizeParams", () => {
  it("ignores order, unknown values and blanks", () => {
    expect(sameFilters({ status: "review,planned" }, { status: "planned,review,zzz" })).toBe(true);
    expect(sameFilters({ status: "review" }, { status: "planned" })).toBe(false);
    expect(sameFilters({ project: "p" }, {})).toBe(false);
    expect(sameFilters({ attention: true }, { attention: true, q: " " })).toBe(true);
  });

  it("normalises a stored view to the canonical params", () => {
    expect(normalizeParams({ status: "done,backlog,zzz", q: " x " })).toMatchObject({ status: "backlog,done", q: "x" });
  });
});

describe("activeFilterCount / isEmptyView / clearedParams", () => {
  it("counts each kind of filter once", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount(readFilters({ status: "review,done", labels: "a,b", attention: true }))).toBe(3);
  });

  it("does not count the project scope, which has its own control", () => {
    expect(activeFilterCount(readFilters({ project: "p" }))).toBe(0);
  });

  it("says whether there is anything to save", () => {
    expect(isEmptyView({})).toBe(true);
    expect(isEmptyView({ status: "nonsense" })).toBe(true);
    expect(isEmptyView({ project: "p" })).toBe(false);
    expect(isEmptyView({ priority: true })).toBe(false);
  });

  it("clears every filter but names no project, so spreading it over a search keeps the scope", () => {
    expect(Object.values(clearedParams()).every((value) => value === undefined)).toBe(true);
    expect(Object.keys(clearedParams())).toContain("status");
    expect(Object.keys(clearedParams())).not.toContain("project");
    expect({ project: "p", status: "done", ...clearedParams() }).toEqual({ project: "p", status: undefined });
  });
});

describe("toggleChoice", () => {
  it("adds and removes, keeping the list's order", () => {
    const choices = ["a", "b", "c"] as const;
    expect(toggleChoice(["c"], "a", choices)).toEqual(["a", "c"]);
    expect(toggleChoice(["a", "c"], "a", choices)).toEqual(["c"]);
  });
});

describe("matchesTaskOwnFilters", () => {
  it("matches anything when no filter is set", () => {
    expect(matchesTaskOwnFilters(task(), EMPTY_FILTERS)).toBe(true);
  });

  it("filters by status, any of", () => {
    const filters = readFilters({ status: "review,done" });
    expect(matchesTaskOwnFilters(task({ status: "review" }), filters)).toBe(true);
    expect(matchesTaskOwnFilters(task({ status: "planned" }), filters)).toBe(false);
  });

  it("filters by tier, with none for a task that has no tier", () => {
    const filters = readFilters({ tier: "deep,none" });
    expect(matchesTaskOwnFilters(task({ suggestedModel: { tier: "deep", reason: null } }), filters)).toBe(true);
    expect(matchesTaskOwnFilters(task(), filters)).toBe(true);
    expect(matchesTaskOwnFilters(task({ suggestedModel: { tier: "light", reason: null } }), filters)).toBe(false);
  });

  it("filters by Autopilot flag: on, off or default", () => {
    expect(autopilotChoice(task({ autopilot: true }))).toBe("on");
    expect(autopilotChoice(task({ autopilot: false }))).toBe("off");
    expect(autopilotChoice(task())).toBe("default");
    const on = readFilters({ autopilot: "on" });
    expect(matchesTaskOwnFilters(task({ autopilot: true }), on)).toBe(true);
    expect(matchesTaskOwnFilters(task({ autopilot: false }), on)).toBe(false);
    expect(matchesTaskOwnFilters(task(), on)).toBe(false);
  });

  it("filters to blocked and priority tasks, and needs both when both are set", () => {
    const filters = readFilters({ blocked: true, priority: true });
    expect(matchesTaskOwnFilters(task({ blocked: true, priority: true }), filters)).toBe(true);
    expect(matchesTaskOwnFilters(task({ blocked: true }), filters)).toBe(false);
    expect(matchesTaskOwnFilters(task({ priority: true }), filters)).toBe(false);
  });
});
