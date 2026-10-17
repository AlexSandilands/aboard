import { SAVED_VIEW_NAME_MAX, SAVED_VIEWS_MAX, type SavedView } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { activeView, addView, canAddView, removeView, renameView, viewNameError } from "./views.logic";

const view = (id: string, name: string, filters: SavedView["filters"] = {}): SavedView => ({ id, name, filters });

describe("viewNameError", () => {
  const views = [view("1", "Review queue")];

  it("accepts a new name", () => {
    expect(viewNameError(views, "Blocked work")).toBeNull();
  });

  it("refuses a blank, a long or a taken name, whatever its case", () => {
    expect(viewNameError(views, "   ")).toMatch(/name/);
    expect(viewNameError(views, "x".repeat(SAVED_VIEW_NAME_MAX + 1))).toMatch(/characters/);
    expect(viewNameError(views, " review QUEUE ")).toMatch(/already exists/);
  });

  it("lets a view keep its own name when it is renamed", () => {
    expect(viewNameError(views, "Review queue", "1")).toBeNull();
  });
});

describe("addView / renameView / removeView", () => {
  it("adds at the end with a trimmed name and normalised filters", () => {
    const next = addView([view("1", "a")], "2", "  Mine ", { status: "done,backlog", q: " x " });
    expect(next.map((v) => v.id)).toEqual(["1", "2"]);
    expect(next[1]).toEqual({
      id: "2",
      name: "Mine",
      filters: expect.objectContaining({ status: "backlog,done", q: "x" }),
    });
  });

  it("renames one view and leaves the rest", () => {
    const next = renameView([view("1", "a"), view("2", "b")], "2", " c ");
    expect(next.map((v) => v.name)).toEqual(["a", "c"]);
  });

  it("removes one view", () => {
    expect(removeView([view("1", "a"), view("2", "b")], "1").map((v) => v.id)).toEqual(["2"]);
  });

  it("stops at the limit", () => {
    const full = Array.from({ length: SAVED_VIEWS_MAX }, (_, i) => view(String(i), `v${i}`));
    expect(canAddView(full)).toBe(false);
    expect(canAddView(full.slice(1))).toBe(true);
  });
});

describe("activeView", () => {
  const views = [
    view("1", "Review", { status: "review" }),
    view("2", "Mine", { priority: true, status: "planned,review" }),
  ];

  it("finds the view whose filters are the board's, however they were written", () => {
    expect(activeView(views, { status: "review" })?.id).toBe("1");
    expect(activeView(views, { status: "review,planned", priority: true })?.id).toBe("2");
  });

  it("finds none when the filters differ", () => {
    expect(activeView(views, { status: "review", q: "x" })).toBeNull();
    expect(activeView(views, {})).toBeNull();
  });
});
