import { describe, expect, it } from "vitest";
import { migrateBoardView, pinnedLaneMaxVh } from "./boardView.logic";

describe("pinnedLaneMaxVh", () => {
  it("maps each size to a share of the viewport", () => {
    expect(pinnedLaneMaxVh("small")).toBe(20);
    expect(pinnedLaneMaxVh("medium")).toBe(30);
    expect(pinnedLaneMaxVh("large")).toBe(45);
  });

  it("reads anything else as the default size", () => {
    for (const bad of [undefined, null, "huge", "", 30, "toString", "__proto__"]) {
      expect(pinnedLaneMaxVh(bad)).toBe(30);
    }
  });
});

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
