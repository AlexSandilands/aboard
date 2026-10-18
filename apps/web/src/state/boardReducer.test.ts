import type { BoardSnapshot, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { applyBoardEvent, applyMove, cellTasks, moveWasReverted, optimisticMove, rollbackMove } from "./boardReducer";

function task(id: string, status: TaskSummary["status"], position: string): TaskSummary {
  return {
    id,
    number: 1,
    projectId: "p",
    kind: "task",
    parent: null,
    rollup: null,
    title: id,
    status,
    position,
    archivedAt: null,
    createdBy: "user",
    createdAt: "",
    updatedAt: "",
    statusChangedAt: "",
    labels: [],
    blockedBy: [],
    blocks: [],
    blocked: false,
    resolution: null,
    resolvedBy: null,
    progress: { done: 0, total: 0 },
    stepStatuses: [],
    currentStep: null,
    links: [],
    attention: [],
    attentionRequest: null,
    lastNote: null,
    autoReview: null,
    autopilot: null,
    priority: false,
    delivery: null,
    integrationBranch: null,
    review: null,
    suggestedModel: null,
    import: null,
  };
}

const board = (tasks: TaskSummary[]): BoardSnapshot => ({
  projects: [],
  tasks,
  labelColors: {},
  integrations: {
    t3: { detected: false, origin: null, environmentId: null, label: null, liveStatus: "off", error: null },
  },
  autopilot: { paused: false, active: [] },
});

describe("applyBoardEvent", () => {
  it("upserts and removes archived tasks", () => {
    const b = board([task("a", "backlog", "a0")]);
    const updated = applyBoardEvent(b, { type: "task.upserted", task: task("a", "planned", "a0") });
    expect(updated.tasks[0]?.status).toBe("planned");
    const archived = applyBoardEvent(b, {
      type: "task.upserted",
      task: { ...task("a", "backlog", "a0"), archivedAt: "x" },
    });
    expect(archived.tasks).toHaveLength(0);
  });

  it("takes a task that an import turned into an epic, with the tasks it gained", () => {
    const b = board([task("a", "backlog", "a0")]);
    const epic = { ...task("a", "backlog", "a0"), kind: "epic" as const };
    const child = { ...task("c", "backlog", "a1"), parent: { id: "a", number: 1, title: "a" } };
    const next = applyBoardEvent(applyBoardEvent(b, { type: "task.upserted", task: epic }), {
      type: "task.upserted",
      task: child,
    });
    expect(next.tasks.map((t) => [t.id, t.kind, t.parent?.id ?? null])).toEqual([
      ["a", "epic", null],
      ["c", "task", "a"],
    ]);
  });

  it("drops a deleted task and leaves the rest alone", () => {
    const b = board([task("a", "backlog", "a0"), task("b", "done", "a0")]);
    const deleted = applyBoardEvent(b, { type: "task.deleted", taskId: "a" });
    expect(deleted.tasks.map((t) => t.id)).toEqual(["b"]);
    // Another client may already have dropped it (e.g. archived, so never on the board).
    expect(applyBoardEvent(deleted, { type: "task.deleted", taskId: "a" }).tasks.map((t) => t.id)).toEqual(["b"]);
  });

  it("replaces the label colours", () => {
    const b = { ...board([]), labelColors: { ui: 10, docs: 20 } };
    expect(applyBoardEvent(b, { type: "labels.colors_changed", labelColors: { ui: 30 } }).labelColors).toEqual({
      ui: 30,
    });
  });
});

describe("applyBoardEvent project archiving", () => {
  it("drops an archived project's tasks with its lane", () => {
    const project = {
      id: "p",
      title: "P",
      workspaceRoot: null,
      workspaceKey: null,
      icon: null,
      t3ProjectId: null,
      reviewSkill: null,
      planSkill: null,
      position: "a0",
      collapsed: false,
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const other = { ...task("o", "backlog", "a0"), projectId: "q" };
    const b = { ...board([task("a", "backlog", "a0"), other]), projects: [project] };
    const archived = applyBoardEvent(b, { type: "project.upserted", project: { ...project, archivedAt: "x" } });
    expect(archived.projects).toEqual([]);
    expect(archived.tasks.map((t) => t.id)).toEqual(["o"]);
  });
});

describe("optimisticMove", () => {
  const b = board([task("a", "planned", "a0"), task("b", "planned", "a1"), task("c", "backlog", "a0")]);
  const order = (s: BoardSnapshot) => cellTasks(s.tasks, "p", "planned").map((t) => t.id);

  it("places after a target", () => {
    expect(order(optimisticMove(b, "c", { status: "planned", afterId: "a" }))).toEqual(["a", "c", "b"]);
  });
  it("places before a target", () => {
    expect(order(optimisticMove(b, "c", { status: "planned", beforeId: "a" }))).toEqual(["c", "a", "b"]);
  });
  it("prefers beforeId when both neighbours are given, like the server", () => {
    expect(order(optimisticMove(b, "c", { status: "planned", beforeId: "a", afterId: "b" }))).toEqual(["c", "a", "b"]);
  });
  it("appends by default", () => {
    expect(order(optimisticMove(b, "c", { status: "planned" }))).toEqual(["a", "b", "c"]);
  });
  it("clears a closed task's resolution when it leaves Done, but not on a reorder", () => {
    const closed: TaskSummary = {
      ...task("d", "done", "a0"),
      resolution: "duplicate",
      resolvedBy: { id: "a", number: 1, title: "a" },
    };
    const withClosed = board([closed, task("e", "done", "a1")]);
    const reordered = optimisticMove(withClosed, "d", { status: "done", afterId: "e" });
    expect(reordered.tasks.find((t) => t.id === "d")).toMatchObject({ resolution: "duplicate" });
    const reopened = optimisticMove(withClosed, "d", { status: "backlog" });
    expect(reopened.tasks.find((t) => t.id === "d")).toMatchObject({ resolution: null, resolvedBy: null });
  });
  it("stamps statusChangedAt on a status change so the card tops Done", () => {
    const moved = optimisticMove(b, "c", { status: "done" }).tasks.find((t) => t.id === "c");
    expect(moved?.statusChangedAt).not.toBe(task("c", "backlog", "a0").statusChangedAt);
    const reordered = optimisticMove(b, "b", { status: "planned", beforeId: "a" }).tasks.find((t) => t.id === "b");
    expect(reordered?.statusChangedAt).toBe(task("b", "planned", "a1").statusChangedAt);
  });
});

describe("move rollback", () => {
  const before = board([task("a", "backlog", "a0"), task("b", "planned", "a0")]);
  const original = before.tasks[0]!;
  const after = applyMove(before, { id: "a", status: "planned", afterId: "b" });
  const moved = after.tasks.find((t) => t.id === "a")!;

  it("spots a move undone by a cancelled fetch, but not one still in place", () => {
    expect(moveWasReverted(before, original)).toBe(true);
    expect(moveWasReverted(after, original)).toBe(false);
  });

  it("puts the task back but keeps fields that changed since", () => {
    const updated = { ...after, tasks: after.tasks.map((t) => (t.id === "a" ? { ...t, title: "renamed" } : t)) };
    const rolled = rollbackMove(updated, original, moved);
    expect(rolled.tasks.find((t) => t.id === "a")).toMatchObject({
      status: "backlog",
      position: "a0",
      title: "renamed",
    });
    expect(rolled.tasks.find((t) => t.id === "b")).toBe(updated.tasks.find((t) => t.id === "b"));
  });

  it("leaves the task alone once something newer has moved it", () => {
    const newer = { ...after, tasks: after.tasks.map((t) => (t.id === "a" ? { ...t, status: "review" as const } : t)) };
    expect(rollbackMove(newer, original, moved)).toBe(newer);
  });
});
