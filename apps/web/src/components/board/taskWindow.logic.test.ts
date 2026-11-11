import { describe, expect, it } from "vitest";
import { isTaskWindowSearch, withClosedTask, withExpanded, withOpenTask } from "./taskWindow.logic";

describe("withOpenTask", () => {
  it("opens a task docked by default, keeping the rest of the search", () => {
    const search: { labels: string; task?: string } = { labels: "ui" };
    expect(withOpenTask(search, "t1")).toEqual({
      labels: "ui",
      task: "t1",
      expanded: undefined,
    });
  });

  it("keeps the window when a task is followed from inside it", () => {
    expect(withOpenTask({ task: "t1", expanded: true as const }, "t2")).toEqual({ task: "t2", expanded: true });
  });

  it("keeps a docked task docked", () => {
    expect(withOpenTask({ task: "t1" }, "t2")).toEqual({ task: "t2", expanded: undefined });
  });

  it("follows an explicit choice either way", () => {
    expect(withOpenTask({}, "t1", true)).toEqual({ task: "t1", expanded: true });
    expect(withOpenTask({ task: "t1", expanded: true as const }, "t2", false)).toEqual({
      task: "t2",
      expanded: undefined,
    });
  });

  it("ignores a stray expanded with no task open", () => {
    expect(withOpenTask({ expanded: true as const }, "t1")).toEqual({ task: "t1", expanded: undefined });
  });
});

describe("withClosedTask", () => {
  it("drops the task and the window together", () => {
    const search = { task: "t1", expanded: true as const, epic: "e" };
    expect(withClosedTask(search)).toEqual({
      task: undefined,
      expanded: undefined,
      epic: "e",
    });
  });
});

describe("withExpanded", () => {
  it("expands and collapses the open task", () => {
    expect(withExpanded({ task: "t1" }, true)).toEqual({ task: "t1", expanded: true });
    expect(withExpanded({ task: "t1", expanded: true as const }, false)).toEqual({ task: "t1", expanded: undefined });
  });

  it("does nothing with no task open", () => {
    expect(withExpanded({}, true)).toEqual({ expanded: undefined });
  });
});

describe("isTaskWindowSearch", () => {
  it("needs both a task and expanded", () => {
    expect(isTaskWindowSearch({ task: "t1", expanded: true })).toBe(true);
    expect(isTaskWindowSearch({ task: "t1" })).toBe(false);
    expect(isTaskWindowSearch({ expanded: true })).toBe(false);
  });
});
