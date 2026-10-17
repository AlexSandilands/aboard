import type { Project, TaskStatus, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { Lane } from "./board.logic";
import {
  canDropIn,
  computeDrop,
  landsPastPreview,
  parseCellKey,
  placementAfterDrop,
  previewMove,
  previewPlacement,
  readDragData,
  type DropInput,
  type DropTask,
  type PlacementInput,
} from "./dnd.logic";

const dropTask = (id: string, rowId: string, status: TaskStatus): DropTask => ({
  id,
  rowId,
  status,
  projectId: "p",
  epicId: null,
});

const base = (overrides: Partial<DropInput>): DropInput => ({
  task: dropTask("a", "p", "planned"),
  target: { rowId: "p", status: "planned" },
  cellTaskIds: ["a", "b", "c"],
  overTaskId: null,
  ...overrides,
});

describe("computeDrop from the priority lane", () => {
  const fromPriority = (overrides: Partial<DropInput>): DropInput =>
    base({
      task: dropTask("a", "priority", "planned"),
      target: { rowId: "priority", status: "planned" },
      ...overrides,
    });

  it("changes column without a place, since positions don't compare across projects", () => {
    expect(computeDrop(fromPriority({ target: { rowId: "priority", status: "review" }, overTaskId: "b" }))).toEqual({
      kind: "move",
      status: "review",
    });
    expect(computeDrop(fromPriority({ overTaskId: "b" }))).toEqual({ kind: "noop" });
  });

  it("rejects another project's lane", () => {
    expect(computeDrop(fromPriority({ target: { rowId: "q", status: "planned" } }))).toEqual({ kind: "invalid" });
  });

  it("clears priority when dropped on its own project, placing it like any card there", () => {
    const own = { rowId: "p", status: "review" as const };
    expect(computeDrop(fromPriority({ target: own, cellTaskIds: ["x", "y"], overTaskId: "y" }))).toEqual({
      kind: "move",
      status: "review",
      afterId: "x",
      clearPriority: true,
    });
    expect(computeDrop(fromPriority({ target: { rowId: "p", status: "planned" }, cellTaskIds: [] }))).toEqual({
      kind: "noop",
      clearPriority: true,
    });
  });

  it("clears priority when dropped in its own epic's band", () => {
    const input = fromPriority({
      task: { ...dropTask("a", "priority", "planned"), epicId: "e" },
      target: { rowId: "e", status: "done" },
      cellTaskIds: [],
    });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "done", clearPriority: true });
  });
});

describe("canDropIn", () => {
  const card = { rowId: "p", projectId: "p", epicId: null };
  it("keeps a card in its row", () => {
    expect(canDropIn(card, "p")).toBe(true);
    expect(canDropIn(card, "q")).toBe(false);
  });
  it("lets only a priority card go to its project or epic", () => {
    const priority = { rowId: "priority", projectId: "p", epicId: "e" };
    expect(canDropIn(priority, "priority")).toBe(true);
    expect(canDropIn(priority, "p")).toBe(true);
    expect(canDropIn(priority, "e")).toBe(true);
    expect(canDropIn(priority, "q")).toBe(false);
  });
});

describe("computeDrop", () => {
  it("rejects drops into another project's lane", () => {
    expect(computeDrop(base({ target: { rowId: "q", status: "planned" } }))).toEqual({ kind: "invalid" });
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
    const input = base({ task: dropTask("c", "p", "planned"), overTaskId: "a" });
    expect(computeDrop(input)).toEqual({ kind: "move", status: "planned", beforeId: "a" });
    expect(computeDrop({ ...input, overTaskId: "b" })).toEqual({ kind: "move", status: "planned", afterId: "a" });
  });

  it("ignores reordering inside Done", () => {
    const input = base({
      task: dropTask("a", "p", "done"),
      target: { rowId: "p", status: "done" },
      overTaskId: "c",
    });
    expect(computeDrop(input)).toEqual({ kind: "noop" });
  });

  describe("into another column, from the preview order", () => {
    const review = (cellTaskIds: string[], overTaskId: string | null = null) =>
      base({ target: { rowId: "p", status: "review" }, cellTaskIds, overTaskId });

    it("lands where the preview put it when dropped on the cell or on itself", () => {
      expect(computeDrop(review(["x", "a", "y"]))).toEqual({ kind: "move", status: "review", afterId: "x" });
      expect(computeDrop(review(["a", "x"], "a"))).toEqual({ kind: "move", status: "review", beforeId: "x" });
      expect(computeDrop(review(["x", "y", "a"]))).toEqual({ kind: "move", status: "review", afterId: "y" });
    });

    it("takes the hovered card's slot after sorting inside the new column", () => {
      expect(computeDrop(review(["a", "x", "y"], "y"))).toEqual({ kind: "move", status: "review", afterId: "y" });
      expect(computeDrop(review(["x", "y", "a"], "x"))).toEqual({ kind: "move", status: "review", beforeId: "x" });
    });

    it("moves into an empty column without neighbours", () => {
      expect(computeDrop(review(["a"]))).toEqual({ kind: "move", status: "review" });
    });

    it("appends when the preview hadn't caught up yet", () => {
      expect(computeDrop(review(["x", "y"]))).toEqual({ kind: "move", status: "review", afterId: "y" });
    });

    it("moves into Done without neighbours, since Done is newest-first", () => {
      const input = base({ target: { rowId: "p", status: "done" }, cellTaskIds: ["a", "x"], overTaskId: "x" });
      expect(computeDrop(input)).toEqual({ kind: "move", status: "done" });
    });
  });
});

describe("previewPlacement", () => {
  const input = (overrides: Partial<PlacementInput>): PlacementInput => ({
    task: dropTask("a", "p", "planned"),
    target: { rowId: "p", status: "review" },
    cellTaskIds: ["x", "y"],
    overTaskId: null,
    placeAfter: false,
    ...overrides,
  });
  const at = (status: TaskStatus, index: number) => ({ taskId: "a", rowId: "p", status, index });

  it("opens a gap before or after the hovered card", () => {
    expect(previewPlacement(input({ overTaskId: "y" }))).toEqual(at("review", 1));
    expect(previewPlacement(input({ overTaskId: "y", placeAfter: true }))).toEqual(at("review", 2));
    expect(previewPlacement(input({ overTaskId: "x" }))).toEqual(at("review", 0));
  });

  it("goes to the end when hovering the cell, or into an empty cell", () => {
    expect(previewPlacement(input({}))).toEqual(at("review", 2));
    expect(previewPlacement(input({ cellTaskIds: [] }))).toEqual(at("review", 0));
  });

  it("ignores the dragged card's own preview copy when counting", () => {
    expect(previewPlacement(input({ cellTaskIds: ["a", "x", "y"], overTaskId: "y", placeAfter: true }))).toEqual(
      at("review", 2),
    );
  });

  it("always puts the card at the top of Done", () => {
    const done = input({ target: { rowId: "p", status: "done" }, overTaskId: "y", placeAfter: true });
    expect(previewPlacement(done)).toEqual(at("done", 0));
  });

  it("has no preview in the card's own column or another project's lane", () => {
    expect(previewPlacement(input({ target: { rowId: "p", status: "planned" } }))).toBeNull();
    expect(previewPlacement(input({ target: { rowId: "q", status: "review" } }))).toBeNull();
  });
});

describe("previewMove", () => {
  const card = (id: string) => ({ id }) as TaskSummary;
  const lane = (id: string, cells: Partial<Record<TaskStatus, string[]>>): Lane => ({
    project: { id } as Project,
    bands: [],
    epicChildren: {},
    cells: {
      backlog: (cells.backlog ?? []).map(card),
      planned: (cells.planned ?? []).map(card),
      in_progress: (cells.in_progress ?? []).map(card),
      review: (cells.review ?? []).map(card),
      done: (cells.done ?? []).map(card),
    },
  });
  const ids = (l: Lane | undefined, status: TaskStatus) => l?.cells[status].map((t) => t.id);
  const lanes = [lane("p", { planned: ["a", "b"], review: ["x", "y"] }), lane("q", { backlog: ["z"] })];

  it("moves the card from its cell into the placement", () => {
    const next = previewMove(lanes, { taskId: "a", rowId: "p", status: "review", index: 1 });
    expect(ids(next[0], "planned")).toEqual(["b"]);
    expect(ids(next[0], "review")).toEqual(["x", "a", "y"]);
  });

  it("clamps an index past the end", () => {
    const next = previewMove(lanes, { taskId: "a", rowId: "p", status: "review", index: 9 });
    expect(ids(next[0], "review")).toEqual(["x", "y", "a"]);
  });

  it("keeps other lanes and cells referentially stable", () => {
    const next = previewMove(lanes, { taskId: "a", rowId: "p", status: "review", index: 0 });
    expect(next[1]).toBe(lanes[1]);
    expect(next[0]!.cells.backlog).toBe(lanes[0]!.cells.backlog);
    expect(next[0]!.cells.done).toBe(lanes[0]!.cells.done);
  });

  it("puts a card dragged into Done above a finished epic's card", () => {
    const withEpic = [lane("p", { planned: ["a"], done: ["epic", "old"] })];
    const next = previewMove(withEpic, { taskId: "a", rowId: "p", status: "done", index: 0 });
    expect(ids(next[0], "done")).toEqual(["a", "epic", "old"]);
  });

  it("reorders within the card's own cell", () => {
    const next = previewMove(lanes, { taskId: "a", rowId: "p", status: "planned", index: 1 });
    expect(ids(next[0], "planned")).toEqual(["b", "a"]);
  });

  it("returns the same lanes when there is nothing to preview", () => {
    expect(previewMove(lanes, null)).toBe(lanes);
    expect(previewMove(lanes, { taskId: "a", rowId: "p", status: "planned", index: 0 })).toBe(lanes);
    expect(previewMove(lanes, { taskId: "gone", rowId: "p", status: "review", index: 0 })).toBe(lanes);
  });
});

describe("placementAfterDrop", () => {
  const task = { id: "a", rowId: "p" };
  const at = (status: TaskStatus, index: number) => ({ taskId: "a", rowId: "p", status, index });

  it("puts the card next to its anchor among the other cards", () => {
    const after = placementAfterDrop(task, ["x", "a", "y"], { kind: "move", status: "review", afterId: "y" });
    expect(after).toEqual(at("review", 2));
    const before = placementAfterDrop(task, ["x", "y"], { kind: "move", status: "review", beforeId: "x" });
    expect(before).toEqual(at("review", 0));
  });

  it("goes last without anchors, and first in Done", () => {
    expect(placementAfterDrop(task, ["x"], { kind: "move", status: "review" })).toEqual(at("review", 1));
    expect(placementAfterDrop(task, ["x"], { kind: "move", status: "done" })).toEqual(at("done", 0));
  });
});

describe("parseCellKey", () => {
  it("reads back a cell key and rejects anything else", () => {
    expect(parseCellKey("p-1:in_progress")).toEqual({ rowId: "p-1", status: "in_progress" });
    expect(parseCellKey("p:nope")).toBeNull();
    expect(parseCellKey(":backlog")).toBeNull();
    expect(parseCellKey(undefined)).toBeNull();
  });
});

describe("readDragData", () => {
  it("accepts task and cell data and rejects anything else", () => {
    expect(readDragData({ type: "cell", rowId: "p", status: "backlog" })).toEqual({
      type: "cell",
      rowId: "p",
      status: "backlog",
    });
    expect(readDragData({ type: "task", rowId: "p", status: "done", sortable: {} })).toEqual({
      type: "task",
      rowId: "p",
      status: "done",
    });
    expect(readDragData({ type: "other", rowId: "p", status: "backlog" })).toBeNull();
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
