import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  cardClickOpens,
  isPlannable,
  isPickClick,
  isWindowPress,
  pickedAmong,
  plannableTasks,
  togglePicked,
} from "./boardSelection.logic";

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

  it("plans Backlog and plan-less open tasks, never epics, archived or done ones", () => {
    expect(isPlannable(task({}))).toBe(true);
    expect(isPlannable(task({ manual: true }))).toBe(false);
    expect(isPlannable(task({ status: "backlog", progress: { done: 0, total: 3 } }))).toBe(true);
    expect(isPlannable(task({ status: "in_progress", progress: { done: 0, total: 0 } }))).toBe(true);
    expect(isPlannable(task({ status: "planned", progress: { done: 0, total: 3 } }))).toBe(false);
    expect(isPlannable(task({ kind: "epic" }))).toBe(false);
    expect(isPlannable(task({ archivedAt: "2026-01-01" }))).toBe(false);
    expect(isPlannable(task({ status: "done" }))).toBe(false);
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

  it("keeps every picked card in the pick, but the planning picker ticks only the plannable ones", () => {
    const tasks = [task({ number: 2 }), task({ number: 3, status: "done" }), task({ number: 4, kind: "epic" })];
    const picked = togglePicked(togglePicked(togglePicked([], "t-2"), "t-3"), "t-4");
    expect(picked).toEqual(["t-2", "t-3", "t-4"]);
    expect(pickedAmong(picked, plannableTasks(tasks, "p-1"))).toEqual(["t-2"]);
  });
});

describe("opening a card", () => {
  const click = (detail: number, altKey = false) => ({ detail, altKey });

  it("opens the panel on a single click or Enter, with no delay to wait for a second", () => {
    expect(cardClickOpens(click(1))).toBe("open");
    expect(cardClickOpens(click(0))).toBe("open");
    expect(cardClickOpens()).toBe("open");
  });

  it("expands on the second click of a double-click", () => {
    expect(cardClickOpens(click(2))).toBe("expand");
    expect(cardClickOpens(click(3))).toBe("none");
  });

  it("opens the window in one step on Alt+click", () => {
    expect(cardClickOpens(click(1, true))).toBe("window");
    expect(cardClickOpens(click(0, true))).toBe("window");
    expect(cardClickOpens(click(2, true))).toBe("none");
  });

  it("keeps text selection and drags away from double and Alt presses only", () => {
    expect(isWindowPress(click(1))).toBe(false);
    expect(isWindowPress(click(2))).toBe(true);
    expect(isWindowPress(click(1, true))).toBe(true);
  });
});
