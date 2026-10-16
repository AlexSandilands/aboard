import { describe, expect, it } from "vitest";
import { MergePrInput, pickMergeMethod, prMergeAction, PrSnapshot } from "./index.ts";

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Add merge",
  checks: "passing",
  reviewDecision: "approved",
  mergeable: "mergeable",
  headRef: "feat/merge",
  updatedAt: null,
  autoMerge: null,
  mergeMethods: ["squash", "merge"],
  autoMergeAllowed: true,
  canMerge: true,
  headOid: "abc",
  ...overrides,
});

describe("prMergeAction", () => {
  it("offers merge only for tasks in Review that the viewer can merge", () => {
    expect(prMergeAction("review", snapshot())).toBe("merge");
    expect(prMergeAction("in_progress", snapshot())).toBeNull();
    expect(prMergeAction("done", snapshot())).toBeNull();
    expect(prMergeAction("review", snapshot({ canMerge: false }))).toBeNull();
    expect(prMergeAction("review", null)).toBeNull();
  });

  it("follows the button order", () => {
    expect(prMergeAction("review", snapshot({ state: "merged" }))).toBeNull();
    expect(prMergeAction("review", snapshot({ state: "closed" }))).toBeNull();
    expect(prMergeAction("review", snapshot({ state: "draft" }))).toBeNull();
    expect(prMergeAction("review", snapshot({ mergeable: "conflicting", autoMerge: "squash" }))).toBeNull();
    expect(prMergeAction("review", snapshot({ autoMerge: "squash", checks: "pending" }))).toBe("armed");
    expect(prMergeAction("review", snapshot({ checks: "pending" }))).toBe("auto");
    expect(prMergeAction("review", snapshot({ checks: "failing" }))).toBe("auto");
    expect(prMergeAction("review", snapshot({ checks: "none" }))).toBe("merge");
    expect(prMergeAction("review", snapshot({ mergeable: "unknown" }))).toBe("merge");
  });

  it("falls back to merge when the repo doesn't allow auto-merge, and offers nothing with no methods", () => {
    expect(prMergeAction("review", snapshot({ checks: "pending", autoMergeAllowed: false }))).toBe("merge");
    expect(prMergeAction("review", snapshot({ mergeMethods: [] }))).toBeNull();
  });

  it("treats snapshots stored before merging existed as not mergeable", () => {
    const old = PrSnapshot.parse({
      state: "open",
      title: "Old",
      checks: "passing",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: null,
      updatedAt: null,
    });
    expect(prMergeAction("review", old)).toBeNull();
  });
});

describe("pickMergeMethod", () => {
  it("prefers the last pick, then squash, merge, rebase", () => {
    expect(pickMergeMethod(["squash", "merge", "rebase"], "rebase")).toBe("rebase");
    expect(pickMergeMethod(["merge", "rebase"], "squash")).toBe("merge");
    expect(pickMergeMethod(["rebase", "merge", "squash"], null)).toBe("squash");
    expect(pickMergeMethod(["rebase"], undefined)).toBe("rebase");
    expect(pickMergeMethod([], "squash")).toBeNull();
  });
});

describe("MergePrInput", () => {
  it("needs a method except to turn auto-merge off", () => {
    expect(MergePrInput.safeParse({ action: "merge", method: "squash" }).success).toBe(true);
    expect(MergePrInput.safeParse({ action: "auto" }).success).toBe(false);
    expect(MergePrInput.safeParse({ action: "disable_auto" }).success).toBe(true);
    expect(MergePrInput.safeParse({ action: "merge", method: "fast-forward" }).success).toBe(false);
  });
});
