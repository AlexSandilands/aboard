import type { CustomHandoff } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyHandoffEdit,
  createHandoffEdits,
  handoffDoes,
  handoffIdFor,
  handoffOfTarget,
  handoffProjectsLabel,
  handoffSummary,
  insertPlaceholder,
  newHandoff,
  nextHandoffId,
  selectedHandoff,
} from "./customHandoffs.logic";

const handoff = (id: string, patch: Partial<CustomHandoff> = {}): CustomHandoff => ({ ...newHandoff(id), ...patch });
const ids = (list: CustomHandoff[]) => list.map((h) => h.id);
const list = [handoff("a"), handoff("b"), handoff("c")];

describe("applyHandoffEdit", () => {
  it("adds a hand-off under an id made from its name, until the list is full", () => {
    expect(handoffIdFor("Sandbox check!", new Set())).toBe("sandbox-check");
    expect(handoffIdFor("  ", new Set())).toBe("hand-off");
    expect(nextHandoffId([{ id: "new-hand-off" }])).toBe("new-hand-off-2");
    const added = applyHandoffEdit(list, { kind: "add", id: "new-hand-off" });
    expect(added.at(-1)).toMatchObject({ id: "new-hand-off", target: "t3-code", skipDialog: false, model: "inherit" });
    const full = Array.from({ length: 20 }, (_, i) => handoff(`h${i}`));
    expect(applyHandoffEdit(full, { kind: "add", id: "one-more" })).toHaveLength(20);
  });

  it("changes fields of one hand-off, keeping its name when the new one is blank", () => {
    const changed = applyHandoffEdit(list, {
      kind: "change",
      id: "b",
      patch: { name: "  ", skipDialog: true, target: "codex" },
    });
    expect(changed[1]).toMatchObject({ name: "New hand-off", skipDialog: true, target: "codex" });
    expect(changed[0]).toBe(list[0]);
    const named = applyHandoffEdit(list, { kind: "change", id: "b", patch: { name: ` ${"x".repeat(80)} ` } });
    expect(named[1]!.name).toHaveLength(60);
  });

  it("reads no project ticked as every project", () => {
    const some = applyHandoffEdit(list, { kind: "change", id: "a", patch: { projectIds: ["p1"] } });
    expect(some[0]!.projectIds).toEqual(["p1"]);
    expect(applyHandoffEdit(some, { kind: "change", id: "a", patch: { projectIds: [] } })[0]!.projectIds).toBeNull();
  });

  it("moves a dragged hand-off to the place of the one it was dropped on", () => {
    expect(ids(applyHandoffEdit(list, { kind: "reorder", id: "a", overId: "c" }))).toEqual(["b", "c", "a"]);
    expect(ids(applyHandoffEdit(list, { kind: "reorder", id: "c", overId: "a" }))).toEqual(["c", "a", "b"]);
    expect(ids(applyHandoffEdit(list, { kind: "reorder", id: "a", overId: "gone" }))).toEqual(["a", "b", "c"]);
  });

  it("removes a hand-off", () => {
    expect(ids(applyHandoffEdit(list, { kind: "remove", id: "b" }))).toEqual(["a", "c"]);
  });
});

describe("createHandoffEdits", () => {
  it("builds an edit on the one still saving, then on the cache again once all have settled", () => {
    const edits = createHandoffEdits();
    edits.compose(list, { kind: "remove", id: "a" });
    // The cache still has all three; the second edit must not bring "a" back.
    expect(ids(edits.compose(list, { kind: "remove", id: "b" }))).toEqual(["c"]);
    edits.settle();
    edits.settle();
    expect(ids(edits.compose(list, { kind: "remove", id: "c" }))).toEqual(["a", "b"]);
  });
});

describe("the list's and the editor's lines", () => {
  const projects = [
    { id: "p1", title: "aboard" },
    { id: "p2", title: "site" },
  ];

  it("summarises where a hand-off runs, on what and for which projects", () => {
    expect(handoffSummary(handoff("a", { workspace: "task_worktree" }), [], projects)).toBe(
      "Task's worktree · Task's model · all projects",
    );
    const custom = handoff("a", { model: { profile: "codex61" }, projectIds: ["p1"], workspace: "current" });
    expect(handoffSummary(custom, [{ id: "codex61", name: "Codex 6.1" }], projects)).toBe(
      "Project checkout · Codex 6.1 · aboard only",
    );
    expect(handoffSummary(handoff("a", { model: { tier: "deep" } }), [], projects)).toContain("Deep tier");
    expect(handoffSummary(handoff("a", { model: { profile: "gone" } }), [], projects)).toContain("Deleted model");
  });

  it("counts only the projects that still exist", () => {
    expect(handoffProjectsLabel(["p1", "p2"], projects)).toBe("2 projects");
    expect(handoffProjectsLabel(["gone"], projects)).toBe("No project");
    expect(handoffProjectsLabel(null, projects)).toBe("All projects");
  });

  it("says what a click does", () => {
    expect(handoffDoes({ target: "t3-code", skipDialog: true })).toBe("Starts a T3 Code thread at once.");
    expect(handoffDoes({ target: "codex", skipDialog: false })).toBe("Opens the Codex session dialog filled in.");
  });
});

describe("insertPlaceholder", () => {
  it("puts the placeholder at the caret, or over the selection, and moves the caret past it", () => {
    expect(insertPlaceholder("Fix  now", 4, 4, "{{task}}")).toEqual({ text: "Fix {{task}} now", caret: 12 });
    expect(insertPlaceholder("Fix THIS now", 4, 8, "{{task.title}}")).toEqual({
      text: "Fix {{task.title}} now",
      caret: 18,
    });
    expect(insertPlaceholder("abc", 99, 99, "X")).toEqual({ text: "abcX", caret: 4 });
  });
});

describe("which hand-off the editor shows", () => {
  it("follows a settings target and falls back to the first", () => {
    expect(handoffOfTarget("agents.handoffs.sandbox-check")).toBe("sandbox-check");
    expect(handoffOfTarget("agents.handoffs")).toBeNull();
    expect(handoffOfTarget("agents.models.custom.x")).toBeNull();
    expect(selectedHandoff("b", list)?.id).toBe("b");
    expect(selectedHandoff("gone", list)?.id).toBe("a");
    expect(selectedHandoff(null, [])).toBeNull();
  });
});
