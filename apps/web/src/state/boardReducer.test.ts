import type { BoardSnapshot, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { applyBoardEvent, cellTasks, optimisticMove } from "./boardReducer";

function task(id: string, status: TaskSummary["status"], position: string): TaskSummary {
  return {
    id,
    number: 1,
    projectId: "p",
    title: id,
    status,
    position,
    archivedAt: null,
    createdBy: "user",
    createdAt: "",
    updatedAt: "",
    statusChangedAt: "",
    resolution: null,
    resolvedBy: null,
    progress: { done: 0, total: 0 },
    stepStatuses: [],
    currentStep: null,
    links: [],
    attention: [],
    lastNote: null,
  };
}

const board = (tasks: TaskSummary[]): BoardSnapshot => ({
  projects: [],
  tasks,
  integrations: {
    t3: { detected: false, origin: null, environmentId: null, label: null, liveStatus: "off", error: null },
  },
});

describe("applyBoardEvent", () => {
  it("upserts and removes archived tasks", () => {
    const b = board([task("a", "idea", "a0")]);
    const updated = applyBoardEvent(b, { type: "task.upserted", task: task("a", "planned", "a0") });
    expect(updated.tasks[0]?.status).toBe("planned");
    const archived = applyBoardEvent(b, {
      type: "task.upserted",
      task: { ...task("a", "idea", "a0"), archivedAt: "x" },
    });
    expect(archived.tasks).toHaveLength(0);
  });

  it("drops a deleted task and leaves the rest alone", () => {
    const b = board([task("a", "idea", "a0"), task("b", "done", "a0")]);
    const deleted = applyBoardEvent(b, { type: "task.deleted", taskId: "a" });
    expect(deleted.tasks.map((t) => t.id)).toEqual(["b"]);
    // Another client may already have dropped it (e.g. archived, so never on the board).
    expect(applyBoardEvent(deleted, { type: "task.deleted", taskId: "a" }).tasks.map((t) => t.id)).toEqual(["b"]);
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
      position: "a0",
      collapsed: false,
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    };
    const other = { ...task("o", "idea", "a0"), projectId: "q" };
    const b = { ...board([task("a", "idea", "a0"), other]), projects: [project] };
    const archived = applyBoardEvent(b, { type: "project.upserted", project: { ...project, archivedAt: "x" } });
    expect(archived.projects).toEqual([]);
    expect(archived.tasks.map((t) => t.id)).toEqual(["o"]);
  });
});

describe("optimisticMove", () => {
  const b = board([task("a", "planned", "a0"), task("b", "planned", "a1"), task("c", "idea", "a0")]);
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
    const reopened = optimisticMove(withClosed, "d", { status: "idea" });
    expect(reopened.tasks.find((t) => t.id === "d")).toMatchObject({ resolution: null, resolvedBy: null });
  });
});
