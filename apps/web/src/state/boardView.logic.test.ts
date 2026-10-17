import { describe, expect, it } from "vitest";
import { migrateBoardView } from "./boardView.logic";

describe("migrateBoardView", () => {
  it("drops v0's per-lane expandedDone and the filters, which are URL params now", () => {
    const v0 = { attentionOnly: true, hasPrOnly: false, showArchived: true, expandedDone: { p: true } };
    expect(migrateBoardView(v0, 0)).toEqual({ collapsedColumns: { done: true }, cellOverrides: {} });
  });

  it("falls back to defaults for missing or malformed state", () => {
    const defaults = { collapsedColumns: { done: true }, cellOverrides: {} };
    expect(migrateBoardView(undefined, 0)).toEqual(defaults);
    expect(migrateBoardView(null, 0)).toEqual(defaults);
    expect(migrateBoardView("garbage", 0)).toEqual(defaults);
    expect(migrateBoardView({ attentionOnly: "yes" }, 0)).toEqual(defaults);
  });

  it("renames the v1 idea column to backlog and keeps the collapse state", () => {
    const v1 = {
      attentionOnly: false,
      hasPrOnly: true,
      showArchived: false,
      collapsedColumns: { idea: true, done: false },
      cellOverrides: { "p:idea": false, "p:done": true },
    };
    expect(migrateBoardView(v1, 1)).toEqual({
      collapsedColumns: { backlog: true, done: false },
      cellOverrides: { "p:backlog": false, "p:done": true },
    });
  });
});
