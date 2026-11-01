import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  bulkArchive,
  bulkCloseable,
  bulkLabel,
  bulkLabelChoices,
  bulkMove,
  bulkPriority,
  bulkSummary,
  bulkWontDo,
  isBulkMenu,
  pickedTasks,
  planGateRefuses,
  referenceList,
  taskCount,
} from "./bulkMenu.logic";

const task = (over: Partial<TaskSummary> & { number: number }): TaskSummary =>
  ({
    id: `t-${over.number}`,
    projectId: "p-1",
    kind: "task",
    status: "backlog",
    archivedAt: null,
    resolution: null,
    priority: false,
    manual: false,
    labels: [],
    progress: { done: 0, total: 3 },
    ...over,
  }) as TaskSummary;

describe("which menu opens", () => {
  it("is the bulk one only for a picked card while two or more are picked", () => {
    expect(isBulkMenu(["a", "b"], "a")).toBe(true);
    expect(isBulkMenu(["a", "b"], "c")).toBe(false);
    expect(isBulkMenu(["a"], "a")).toBe(false);
    expect(isBulkMenu([], "a")).toBe(false);
  });

  it("resolves archived cards too when they are passed in", () => {
    const tasks = [task({ number: 5 }), task({ number: 3, archivedAt: "2026-01-01" })];
    expect(pickedTasks(["t-5", "t-3"], tasks).map((t) => t.number)).toEqual([3, 5]);
  });

  it("resolves the pick to existing cards in number order, dropping deleted ones", () => {
    const tasks = [task({ number: 5 }), task({ number: 2 }), task({ number: 9 })];
    expect(pickedTasks(["t-5", "t-2", "t-gone"], tasks).map((t) => t.number)).toEqual([2, 5]);
  });
});

describe("bulk move", () => {
  it("skips cards already there, epics and archived cards", () => {
    const tasks = [
      task({ number: 1, status: "planned" }),
      task({ number: 2, status: "review" }),
      task({ number: 3, kind: "epic", status: "backlog" }),
      task({ number: 4, status: "planned", archivedAt: "2026-01-01" }),
    ];
    expect(bulkMove(tasks, "review").move.map((t) => t.number)).toEqual([1]);
  });

  it("refuses planless cards outside Backlog, but not manual ones", () => {
    const planless = task({ number: 1, status: "backlog", progress: { done: 0, total: 0 } });
    const manual = task({ number: 2, status: "backlog", progress: { done: 0, total: 0 }, manual: true });
    const planned = task({ number: 3, status: "backlog" });
    const result = bulkMove([planless, manual, planned], "in_progress");
    expect(result.refused.map((t) => t.number)).toEqual([1]);
    expect(result.move.map((t) => t.number)).toEqual([2, 3]);
    expect(planGateRefuses(planless, "backlog")).toBe(false);
  });

  it("applies to none when every card is already in the status", () => {
    const result = bulkMove([task({ number: 1, status: "done" }), task({ number: 2, status: "done" })], "done");
    expect(result.move).toEqual([]);
    expect(result.refused).toEqual([]);
  });
});

describe("bulk priority, close and archive", () => {
  const tasks = [
    task({ number: 1, priority: true }),
    task({ number: 2 }),
    task({ number: 3, kind: "epic" }),
    task({ number: 4, archivedAt: "2026-01-01", resolution: "wont_do" }),
  ];

  it("changes only open tasks whose priority differs", () => {
    expect(bulkPriority(tasks, true).map((t) => t.number)).toEqual([2]);
    expect(bulkPriority(tasks, false).map((t) => t.number)).toEqual([1]);
  });

  it("closes tasks, never epics, and leaves Won't do ones alone", () => {
    expect(bulkWontDo(tasks).map((t) => t.number)).toEqual([1, 2]);
    expect(bulkCloseable(tasks).map((t) => t.number)).toEqual([1, 2, 4]);
  });

  it("archives the unarchived and unarchives the archived", () => {
    expect(bulkArchive(tasks, true).map((t) => t.number)).toEqual([1, 2, 3]);
    expect(bulkArchive(tasks, false).map((t) => t.number)).toEqual([4]);
  });
});

describe("bulk labels", () => {
  const full = Array.from({ length: 10 }, (_, i) => `l${i}`);
  const tasks = [
    task({ number: 1, labels: ["ui"] }),
    task({ number: 2, labels: ["ui", "bug"] }),
    task({ number: 3, labels: [] }),
    task({ number: 4, labels: full }),
  ];

  it("adds to cards without the label and with room for another", () => {
    expect(bulkLabel(tasks, "ui", "add").map((t) => t.number)).toEqual([3]);
    expect(bulkLabel(tasks, "new", "add").map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it("removes from cards carrying it", () => {
    expect(bulkLabel(tasks, "ui", "remove").map((t) => t.number)).toEqual([1, 2]);
  });

  it("offers only labels that would change something", () => {
    const picked = tasks.slice(0, 3);
    expect(bulkLabelChoices(picked, ["bug", "ui", "x"], "add")).toEqual(["bug", "ui", "x"]);
    expect(bulkLabelChoices([picked[1]!], ["bug", "ui", "x"], "add")).toEqual(["x"]);
    expect(bulkLabelChoices(picked, ["bug", "ui", "x"], "remove")).toEqual(["bug", "ui"]);
  });
});

describe("wording", () => {
  it("lists references and counts tasks", () => {
    expect(referenceList([task({ number: 14 }), task({ number: 16 }), task({ number: 26 })])).toBe("#14, #16, #26");
    expect(taskCount(1)).toBe("1 task");
    expect(taskCount(3)).toBe("3 tasks");
  });

  it("summarises what was done, skipped and failed", () => {
    expect(bulkSummary((n) => `Moved ${n} to Review`, { ok: 3 })).toBe("Moved 3 tasks to Review");
    expect(bulkSummary((n) => `Moved ${n} to Review`, { ok: 2, skipped: 1, failed: 1 }, "no plan")).toBe(
      "Moved 2 tasks to Review, 1 skipped (no plan), 1 failed",
    );
  });
});
