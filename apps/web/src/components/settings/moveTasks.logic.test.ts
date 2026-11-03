import type { ImportProject, ImportTask } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { blockedReason, matchNote, projectMap, projectTargets, taskNote } from "./moveTasks.logic";

const task = (overrides: Partial<ImportTask> = {}): ImportTask => ({
  taskId: "t1",
  number: 4,
  title: "Feature",
  status: "in_progress",
  kind: "task",
  projectId: "p1",
  archived: false,
  onBoard: "no",
  busy: false,
  movedTo: null,
  ...overrides,
});
const project = (overrides: Partial<ImportProject> = {}): ImportProject => ({
  id: "p1",
  title: "Alpha",
  remote: null,
  matchId: null,
  matchedBy: null,
  ...overrides,
});

describe("moving tasks from another machine", () => {
  it("blocks tasks already here, and busy ones only for a move", () => {
    expect(blockedReason(task(), "move")).toBeNull();
    expect(blockedReason(task({ onBoard: "here" }), "copy")).toBe("Already on this board");
    expect(blockedReason(task({ busy: true }), "copy")).toBeNull();
    expect(blockedReason(task({ busy: true }), "move")).toMatch(/copy it/);
    expect(blockedReason(task({ onBoard: "archived" }), "move")).toBeNull();
    const gone = task({ archived: true, movedTo: { machine: "desktop", number: 9 } });
    expect(blockedReason(gone, "move")).toBe("Moved to desktop #9: move it from there");
    expect(blockedReason(gone, "copy")).toBeNull();
  });

  it("describes a task", () => {
    expect(taskNote(task(), "Alpha")).toBe("Alpha · in progress");
    expect(taskNote(task({ archived: true, onBoard: "archived", busy: true }), null)).toBe(
      "Unknown project · archived there · replaces the archived copy here · busy there",
    );
  });

  it("maps only the projects of picked tasks, sending a choice only where one was made", () => {
    const projects = [project(), project({ id: "p2", title: "Beta", matchId: "here-2", matchedBy: "name" })];
    const tasks = [task(), task({ taskId: "t2", projectId: "p2" })];
    expect(projectTargets(projects, tasks, new Set(["t2"]), {})).toEqual([{ project: projects[1], target: "here-2" }]);
    const both = projectTargets(projects, tasks, new Set(["t1", "t2"]), { p1: "here-1" });
    expect(both.map((t) => t.target)).toEqual(["here-1", "here-2"]);
    expect(projectMap(both)).toEqual({ p1: "here-1", p2: "here-2" });
    expect(projectMap(projectTargets(projects, tasks, new Set(["t1"]), {}))).toEqual({});
  });

  it("says how a project matched", () => {
    expect(matchNote(project({ matchedBy: "remote", remote: "github.com/me/a" }))).toBe("Same repo (github.com/me/a)");
    expect(matchNote(project())).toMatch(/pick one/);
  });
});
