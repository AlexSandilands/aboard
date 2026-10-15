import { describe, expect, it } from "vitest";
import { computeDrop, landsPastPreview, readDragData, type DropInput } from "./dnd.logic";

const base = (overrides: Partial<DropInput>): DropInput => ({
  task: { id: "a", projectId: "p", status: "planned" },
  target: { projectId: "p", status: "planned" },
  cellTaskIds: ["a", "b", "c"],
  overTaskId: null,
  placeAfter: false,
  ...overrides,
});

describe("computeDrop", () => {
  it("rejects drops into another project's lane", () => {
    expect(computeDrop(base({ target: { projectId: "q", status: "planned" } }))).toEqual({ kind: "invalid" });
  });

  it("does nothing when dropped on itself or its own cell", () => {
    expect(computeDrop(base({ overTaskId: "a" }))).toEqual({ kind: "noop" });
    expect(computeDrop(base({ overTaskId: null }))).toEqual({ kind: "noop" });
  });

  it("reorders down within a cell, landing after the hovered card", () => {
    expect(computeDrop(base({ overTaskId: "c" }))).toEqual({ kind: "move", status: "planned", afterId: "c" });
    expect(computeDrop(base({ overTaskId: "b" }))).toEqual({ kind: "move", status: "planned", afterId: "b" });
  });

  it("reorders up within a cell, landing before the hovered card", () => {
    const input = base({ task: { id: "c", projectId: "p", status: "planned" }, overTaskId: "a" });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "planned", beforeId: "a" });
    expect(computeDrop({ ...input, overTaskId: "b" })).toEqual({ kind: "move", status: "planned", afterId: "a" });
  });

  it("ignores reordering inside Done", () => {
    const input = base({
      task: { id: "a", projectId: "p", status: "done" },
      target: { projectId: "p", status: "done" },
      overTaskId: "c",
    });
    expect(computeDrop(input)).toEqual({ kind: "noop" });
  });

  it("appends to the end of another column when dropped on the cell", () => {
    const input = base({ target: { projectId: "p", status: "review" }, cellTaskIds: ["x", "y"] });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "review", afterId: "y" });
  });

  it("moves into an empty column without neighbours", () => {
    const input = base({ target: { projectId: "p", status: "review" }, cellTaskIds: [] });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "review" });
  });

  it("places before or after the hovered card in another column", () => {
    const input = base({ target: { projectId: "p", status: "review" }, cellTaskIds: ["x", "y"], overTaskId: "x" });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "review", beforeId: "x" });
    expect(computeDrop({ ...input, placeAfter: true })).toEqual({ kind: "move", status: "review", afterId: "x" });
  });

  it("appends when the hovered card is not in the target cell", () => {
    const input = base({ target: { projectId: "p", status: "review" }, cellTaskIds: ["x"], overTaskId: "zzz" });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "review", afterId: "x" });
  });
});

describe("readDragData", () => {
  it("accepts task and cell data and rejects anything else", () => {
    expect(readDragData({ type: "cell", projectId: "p", status: "idea" })).toEqual({
      type: "cell",
      projectId: "p",
      status: "idea",
    });
    expect(readDragData({ type: "task", projectId: "p", status: "done", sortable: {} })).toEqual({
      type: "task",
      projectId: "p",
      status: "done",
    });
    expect(readDragData({ type: "other", projectId: "p", status: "idea" })).toBeNull();
    expect(readDragData(undefined)).toBeNull();
  });
});

describe("landsPastPreview", () => {
  const full = ["a", "b", "c", "d"];

  it("is false when the card lands within the preview", () => {
    expect(landsPastPreview({ kind: "move", status: "planned", beforeId: "a" }, "x", full, 2)).toBe(false);
    expect(landsPastPreview({ kind: "move", status: "planned", afterId: "a" }, "x", full, 2)).toBe(false);
  });

  it("is true when the card lands past the preview", () => {
    expect(landsPastPreview({ kind: "move", status: "planned", afterId: "b" }, "x", full, 2)).toBe(true);
    expect(landsPastPreview({ kind: "move", status: "planned", beforeId: "c" }, "x", full, 2)).toBe(true);
  });

  it("ignores the dragged card's old slot in the same cell", () => {
    expect(landsPastPreview({ kind: "move", status: "planned", afterId: "b" }, "a", full, 2)).toBe(false);
  });

  it("never applies to Done or to non-moves", () => {
    expect(landsPastPreview({ kind: "move", status: "done", afterId: "d" }, "x", full, 2)).toBe(false);
    expect(landsPastPreview({ kind: "noop" }, "x", full, 2)).toBe(false);
  });
});
