import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { canPickTask, isPickClick, pickedAmong, plannableTasks, togglePicked } from "./boardSelection.logic";

const task = (over: Partial<TaskSummary>): TaskSummary =>
  ({
    id: `t-${over.number ?? 1}`,
    number: 1,
    projectId: "p-1",
    kind: "task",
    status: "backlog",
    archivedAt: null,
    progress: { done: 0, total: 0 },
    ...over,
  }) as TaskSummary;

describe("picking cards to plan", () => {
  it("toggles on Ctrl or ⌘ only", () => {
    expect(isPickClick({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isPickClick({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPickClick({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it("adds and removes ids", () => {
    expect(togglePicked([], "a")).toEqual(["a"]);
    expect(togglePicked(["a", "b"], "a")).toEqual(["b"]);
  });

  it("picks Backlog and plan-less open tasks, never epics, archived or done ones", () => {
    expect(canPickTask(task({}))).toBe(true);
    expect(canPickTask(task({ status: "backlog", progress: { done: 0, total: 3 } }))).toBe(true);
    expect(canPickTask(task({ status: "in_progress", progress: { done: 0, total: 0 } }))).toBe(true);
    expect(canPickTask(task({ status: "planned", progress: { done: 0, total: 3 } }))).toBe(false);
    expect(canPickTask(task({ kind: "epic" }))).toBe(false);
    expect(canPickTask(task({ archivedAt: "2026-01-01" }))).toBe(false);
    expect(canPickTask(task({ status: "done" }))).toBe(false);
  });

  it("lists the project's plannable tasks in number order and keeps the pick among them", () => {
    const tasks = [
      task({ number: 5 }),
      task({ number: 2 }),
      task({ number: 3, projectId: "p-2" }),
      task({ number: 4, kind: "epic" }),
    ];
    const plannable = plannableTasks(tasks, "p-1");
    expect(plannable.map((t) => t.number)).toEqual([2, 5]);
    expect(pickedAmong(["t-5", "t-3", "t-2"], plannable)).toEqual(["t-2", "t-5"]);
  });
});
