import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  columnComparator,
  columnSortFor,
  columnSortOptions,
  isSortedColumn,
  priorityLaneComparator,
  type ColumnSort,
} from "./columnSort.logic";

type Fields = Pick<
  TaskSummary,
  | "id"
  | "kind"
  | "manual"
  | "position"
  | "createdAt"
  | "updatedAt"
  | "statusChangedAt"
  | "number"
  | "progress"
  | "dueDate"
>;

function card(id: string, overrides: Partial<Fields> = {}): TaskSummary {
  const fields: Fields = {
    id,
    kind: "task",
    manual: false,
    position: "a0",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    statusChangedAt: "2026-01-01T00:00:00.000Z",
    number: 1,
    progress: { done: 0, total: 3 },
    dueDate: null,
    ...overrides,
  };
  return fields as TaskSummary;
}

const ids = (cards: TaskSummary[], sort: ColumnSort) => [...cards].sort(columnComparator(sort)).map((c) => c.id);

describe("columnComparator", () => {
  const a = card("a", { position: "a2", createdAt: "2026-01-01", updatedAt: "2026-03-01", number: 3 });
  const b = card("b", { position: "a1", createdAt: "2026-01-03", updatedAt: "2026-01-05", number: 7 });
  const c = card("c", { position: "a3", createdAt: "2026-01-02", updatedAt: "2026-02-01", number: 5 });
  const cards = [a, b, c];

  it("orders by each sort", () => {
    expect(ids(cards, "manual")).toEqual(["b", "a", "c"]);
    expect(ids(cards, "created_desc")).toEqual(["b", "c", "a"]);
    expect(ids(cards, "created_asc")).toEqual(["a", "c", "b"]);
    expect(ids(cards, "updated")).toEqual(["a", "c", "b"]);
    expect(ids(cards, "number_desc")).toEqual(["b", "c", "a"]);
    expect(ids(cards, "number_asc")).toEqual(["a", "c", "b"]);
  });

  it("finishes newest first", () => {
    const done = [card("old", { statusChangedAt: "2026-01-01" }), card("new", { statusChangedAt: "2026-02-01" })];
    expect(ids(done, "finished")).toEqual(["new", "old"]);
  });

  it("puts tasks without a plan first, but not epics or manual tasks", () => {
    const planned = card("planned", { createdAt: "2026-01-09" });
    const unplanned = card("unplanned", { progress: { done: 0, total: 0 } });
    const epic = card("epic", { kind: "epic", progress: { done: 0, total: 0 }, createdAt: "2026-01-08" });
    const manual = card("manual", { manual: true, progress: { done: 0, total: 0 }, createdAt: "2026-01-07" });
    expect(ids([planned, epic, manual, unplanned], "needs_plan")).toEqual(["unplanned", "planned", "epic", "manual"]);
  });

  it("orders by due date soonest first, tasks without one last", () => {
    const none = card("none", { createdAt: "2026-05-01" });
    const late = card("late", { dueDate: "2026-12-01" });
    const soon = card("soon", { dueDate: "2026-11-20" });
    expect(ids([none, late, soon], "due")).toEqual(["soon", "late", "none"]);
  });

  it("breaks ties by newest created, then by position", () => {
    const older = card("older", { dueDate: "2026-11-20", createdAt: "2026-01-01", position: "a0" });
    const newer = card("newer", { dueDate: "2026-11-20", createdAt: "2026-01-02", position: "a9" });
    const sameLater = card("same-later", { dueDate: "2026-11-20", createdAt: "2026-01-01", position: "a5" });
    expect(ids([sameLater, older, newer], "due")).toEqual(["newer", "older", "same-later"]);
  });
});

describe("column sort choice", () => {
  it("defaults to Manual, and Done to Recently finished", () => {
    expect(columnSortFor({}, "backlog")).toBe("manual");
    expect(columnSortFor(undefined, "review")).toBe("manual");
    expect(columnSortFor({}, "done")).toBe("finished");
  });

  it("offers Recently finished only in Done, and Manual everywhere else", () => {
    expect(columnSortOptions("done")).not.toContain("manual");
    expect(columnSortOptions("done")).toContain("finished");
    expect(columnSortOptions("backlog")).toContain("manual");
    expect(columnSortOptions("backlog")).not.toContain("finished");
  });

  it("falls back to the default for a stored sort that isn't offered or known", () => {
    expect(columnSortFor({ done: "manual" }, "done")).toBe("finished");
    expect(columnSortFor({ backlog: "bogus" as ColumnSort }, "backlog")).toBe("manual");
    expect(isSortedColumn({ backlog: "bogus" as ColumnSort }, "backlog")).toBe(false);
  });

  it("calls a column sorted only when it isn't on its default", () => {
    expect(isSortedColumn({ backlog: "created_desc" }, "backlog")).toBe(true);
    expect(isSortedColumn({ backlog: "manual" }, "backlog")).toBe(false);
    expect(isSortedColumn({ done: "finished" }, "done")).toBe(false);
  });
});

describe("priorityLaneComparator", () => {
  it("keeps cards grouped by project, each project's in the sort", () => {
    const withProject = (id: string, projectId: string, number: number): TaskSummary => ({
      ...card(id, { number }),
      projectId,
    });

    const cards = [withProject("q9", "q", 9), withProject("p1", "p", 1), withProject("p5", "p", 5)];
    const rank = (t: TaskSummary) => (t.projectId === "p" ? 0 : 1);
    expect([...cards].sort(priorityLaneComparator("number_desc", rank)).map((c) => c.id)).toEqual(["p5", "p1", "q9"]);
  });
});
