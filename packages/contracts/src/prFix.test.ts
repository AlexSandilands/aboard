import { describe, expect, it } from "vitest";
import { fixGaveUpPrefix, prProblems, prRowSlot, type PrAutopilotState, type PrSnapshot } from "./index.ts";

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Add the thing",
  checks: "passing",
  reviewDecision: "approved",
  mergeable: "mergeable",
  headRef: "feat/thing",
  updatedAt: null,
  autoMerge: null,
  mergeMethods: ["squash"],
  autoMergeAllowed: true,
  canMerge: true,
  headOid: "abc",
  ...overrides,
});

describe("prProblems", () => {
  it("lists failing checks, conflicts and requested changes, in that order", () => {
    expect(prProblems(snapshot())).toEqual([]);
    expect(prProblems(snapshot({ checks: "failing" }))).toEqual(["checks"]);
    expect(prProblems(snapshot({ mergeable: "conflicting" }))).toEqual(["conflict"]);
    expect(prProblems(snapshot({ reviewDecision: "changes_requested" }))).toEqual(["changes"]);
    expect(
      prProblems(snapshot({ checks: "failing", mergeable: "conflicting", reviewDecision: "changes_requested" })),
    ).toEqual(["checks", "conflict", "changes"]);
    // Running checks and an unknown mergeability say nothing yet.
    expect(prProblems(snapshot({ checks: "pending", mergeable: "unknown" }))).toEqual([]);
  });

  it("fixes only an open or draft PR in the base repository, with a head to start from", () => {
    const broken = { checks: "failing" } as const;
    expect(prProblems(snapshot({ ...broken, state: "draft" }))).toEqual(["checks"]);
    expect(prProblems(snapshot({ ...broken, state: "merged" }))).toEqual([]);
    expect(prProblems(snapshot({ ...broken, state: "closed" }))).toEqual([]);
    expect(prProblems(snapshot({ ...broken, isCrossRepository: true }))).toEqual([]);
    expect(prProblems(snapshot({ ...broken, headRef: null }))).toEqual([]);
    expect(prProblems(snapshot({ ...broken, headOid: null }))).toEqual([]);
    expect(prProblems(null)).toEqual([]);
  });
});

describe("prRowSlot", () => {
  const slot = (
    snap: PrSnapshot | null,
    over: Partial<{
      taskStatus: "review" | "in_progress" | "done";
      canFix: boolean;
      autopilot: PrAutopilotState | null;
    }> = {},
  ) => prRowSlot({ taskStatus: "review", canFix: true, autopilot: null, snapshot: snap, ...over });

  it("offers Merge when there is nothing to fix, as before", () => {
    expect(slot(snapshot())).toEqual({
      primary: { kind: "merge", action: "merge" },
      menu: { merge: null, fix: false },
    });
    expect(slot(snapshot({ checks: "pending" })).primary).toEqual({ kind: "merge", action: "auto" });
    expect(slot(snapshot(), { taskStatus: "in_progress" }).primary).toBeNull();
    expect(slot(null).primary).toBeNull();
    // Auto-merge already on is a badge and a menu item, not a slot.
    expect(slot(snapshot({ autoMerge: "squash" })).primary).toBeNull();
  });

  it("offers Fix in → when something is wrong, and moves Merge into the menu when both apply", () => {
    // Failing checks with auto-merge allowed: "Enable auto-merge" gives way.
    expect(slot(snapshot({ checks: "failing" }))).toEqual({
      primary: { kind: "fix" },
      menu: { merge: "auto", fix: false },
    });
    // Checks pass but changes were requested: Merge gives way.
    expect(slot(snapshot({ reviewDecision: "changes_requested" }))).toEqual({
      primary: { kind: "fix" },
      menu: { merge: "merge", fix: false },
    });
    // Conflicting PRs never offered Merge.
    expect(slot(snapshot({ mergeable: "conflicting" }))).toEqual({
      primary: { kind: "fix" },
      menu: { merge: null, fix: false },
    });
  });

  it("offers Fix in → on tasks that can't merge yet, but not on Done tasks", () => {
    expect(slot(snapshot({ checks: "failing" }), { taskStatus: "in_progress" })).toEqual({
      primary: { kind: "fix" },
      menu: { merge: null, fix: false },
    });
    expect(slot(snapshot({ checks: "failing" }), { taskStatus: "done" }).primary).toBeNull();
  });

  it("offers Fix in → only where a session can be started", () => {
    // An epic, or a link with no repository and number.
    expect(slot(snapshot({ checks: "failing" }), { canFix: false })).toEqual({
      primary: { kind: "merge", action: "auto" },
      menu: { merge: null, fix: false },
    });
    expect(slot(snapshot({ mergeable: "conflicting" }), { canFix: false }).primary).toBeNull();
  });

  it("shows Autopilot's state in the slot and moves Fix in → into the menu", () => {
    const broken = snapshot({ checks: "failing" });
    expect(slot(broken, { autopilot: "fixing" })).toEqual({
      primary: { kind: "autopilot", state: "fixing" },
      menu: { merge: "auto", fix: true },
    });
    expect(slot(broken, { autopilot: "gave_up" }).primary).toEqual({ kind: "autopilot", state: "gave_up" });
    // With nothing to fix there is nothing for Autopilot to be doing.
    expect(slot(snapshot(), { autopilot: "fixing" }).primary).toEqual({ kind: "merge", action: "merge" });
  });
});

describe("fixGaveUpPrefix", () => {
  it("names the PR", () => {
    expect(fixGaveUpPrefix(7)).toBe("Autopilot gave up on PR #7:");
  });
});
