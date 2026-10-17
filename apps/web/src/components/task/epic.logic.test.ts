import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { epicChildGroups, epicOptions, showOnBoardToggle } from "./epic.logic";

const task = (id: string, overrides: Partial<TaskSummary> = {}) =>
  ({ id, number: 1, kind: "task", projectId: "p", status: "backlog", archivedAt: null, ...overrides }) as TaskSummary;

describe("epicChildGroups", () => {
  it("groups by status in board order, skipping empty statuses and putting archived children last", () => {
    const groups = epicChildGroups([
      task("r", { status: "review" }),
      task("old", { archivedAt: "2026-10-01" }),
      task("b"),
    ]);
    expect(groups.map((g) => [g.status, g.tasks.map((t) => t.id)])).toEqual([
      ["backlog", ["b", "old"]],
      ["review", ["r"]],
    ]);
  });
});

describe("epicOptions", () => {
  const tasks = [
    task("e2", { kind: "epic", number: 9 }),
    task("e1", { kind: "epic", number: 3 }),
    task("elsewhere", { kind: "epic", projectId: "q" }),
    task("archived", { kind: "epic", archivedAt: "2026-10-01" }),
    task("plain"),
  ];

  it("lists open epics in the task's project by number", () => {
    expect(epicOptions(tasks, { kind: "task", projectId: "p" }).map((t) => t.id)).toEqual(["e1", "e2"]);
  });

  it("offers nothing to an epic", () => {
    expect(epicOptions(tasks, { kind: "epic", projectId: "p" })).toEqual([]);
  });
});

describe("showOnBoardToggle", () => {
  it("sets the filter when the board shows everything", () => {
    expect(showOnBoardToggle("e1", null)).toEqual({ label: "Show on board", pressed: false, next: "e1" });
  });

  it("is pressed and clears the filter when the board shows this epic", () => {
    expect(showOnBoardToggle("e1", "e1")).toEqual({ label: "Showing on board", pressed: true, next: null });
  });

  it("switches to this epic when the board shows another", () => {
    expect(showOnBoardToggle("e1", "e2")).toEqual({ label: "Show on board", pressed: false, next: "e1" });
  });
});
