import { describe, expect, it } from "vitest";
import { migrateBoardView } from "./boardView.logic";

describe("migrateBoardView", () => {
  it("keeps v0 filters and drops the per-lane expandedDone", () => {
    const v0 = { attentionOnly: true, hasPrOnly: false, showArchived: true, expandedDone: { p: true } };
    expect(migrateBoardView(v0)).toEqual({
      attentionOnly: true,
      hasPrOnly: false,
      showArchived: true,
      collapsedColumns: { done: true },
      cellOverrides: {},
    });
  });

  it("falls back to defaults for missing or malformed state", () => {
    const defaults = {
      attentionOnly: false,
      hasPrOnly: false,
      showArchived: false,
      collapsedColumns: { done: true },
      cellOverrides: {},
    };
    expect(migrateBoardView(undefined)).toEqual(defaults);
    expect(migrateBoardView(null)).toEqual(defaults);
    expect(migrateBoardView("garbage")).toEqual(defaults);
    expect(migrateBoardView({ attentionOnly: "yes" })).toEqual(defaults);
  });
});
