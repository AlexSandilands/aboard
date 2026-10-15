import { describe, expect, it } from "vitest";
import { isCellCollapsed, isColumnMixed, toggleCell, toggleColumn, type CollapseState } from "./columnCollapse.logic";

const initial: CollapseState = { collapsedColumns: { done: true }, cellOverrides: {} };

describe("isCellCollapsed", () => {
  it("follows the column default", () => {
    expect(isCellCollapsed(initial, "p", "done")).toBe(true);
    expect(isCellCollapsed(initial, "p", "backlog")).toBe(false);
  });

  it("prefers the project's override", () => {
    const state = { ...initial, cellOverrides: { "p:done": false } };
    expect(isCellCollapsed(state, "p", "done")).toBe(false);
    expect(isCellCollapsed(state, "q", "done")).toBe(true);
  });
});

describe("toggleCell", () => {
  it("overrides only that project", () => {
    const state = toggleCell(initial, "p", "backlog");
    expect(state.cellOverrides).toEqual({ "p:backlog": true });
    expect(isCellCollapsed(state, "p", "backlog")).toBe(true);
    expect(isCellCollapsed(state, "q", "backlog")).toBe(false);
  });

  it("prunes an override that returns to the column default", () => {
    expect(toggleCell(toggleCell(initial, "p", "done"), "p", "done").cellOverrides).toEqual({});
  });
});

describe("isColumnMixed", () => {
  const state = toggleCell(initial, "p", "done");

  it("is mixed when a shown project overrides the column", () => {
    expect(isColumnMixed(state, "done", ["p", "q"])).toBe(true);
    expect(isColumnMixed(state, "backlog", ["p", "q"])).toBe(false);
  });

  it("ignores overrides of projects not shown", () => {
    expect(isColumnMixed(state, "done", ["q"])).toBe(false);
  });
});

describe("toggleColumn", () => {
  it("flips the column and clears its overrides", () => {
    const state = toggleCell(toggleCell(initial, "p", "backlog"), "p", "done");
    const next = toggleColumn(state, "backlog", false);
    expect(next.collapsedColumns).toEqual({ done: true, backlog: true });
    expect(next.cellOverrides).toEqual({ "p:done": false });
  });

  it("collapses every project when mixed", () => {
    const next = toggleColumn(toggleCell(initial, "p", "done"), "done", true);
    expect(next.collapsedColumns.done).toBe(true);
    expect(next.cellOverrides).toEqual({});
    expect(isCellCollapsed(next, "p", "done")).toBe(true);
  });
});
