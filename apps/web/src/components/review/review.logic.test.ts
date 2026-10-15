import type { ReviewFinding, SkillInfo, TaskReview } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  autoReviewChoice,
  autoReviewOptions,
  autoReviewValue,
  findingLocation,
  hasOpenGating,
  reviewBadgeVariant,
  skillKey,
  skillOptions,
  sortFindings,
  visibleFindings,
} from "./review.logic";

function finding(label: string, patch: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: label,
    reviewId: "r",
    label,
    severity: "minor",
    file: null,
    line: null,
    title: label,
    body: null,
    suggestion: null,
    status: "open",
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "",
    ...patch,
  };
}

const review = (findings: ReviewFinding[]): TaskReview => ({
  id: "r",
  taskId: "t",
  round: 1,
  cycle: 1,
  status: "submitted",
  trigger: "move",
  openedBy: "agent",
  reviewer: "agent (reviewer)",
  skill: "aboard-review",
  headSha: null,
  summary: null,
  error: null,
  nudgedAt: null,
  createdAt: "",
  updatedAt: "",
  completedAt: null,
  findings,
});

describe("review logic", () => {
  it("maps states to badge variants", () => {
    const summary = { round: 1, maxRounds: 3, open: { blocking: 0, major: 0, minor: 0, nit: 0 }, byBoard: false };
    expect(reviewBadgeVariant({ ...summary, state: "clean" })).toBe("success");
    expect(reviewBadgeVariant({ ...summary, state: "stuck" })).toBe("warning");
    expect(reviewBadgeVariant({ ...summary, state: "failed" })).toBe("error");
    expect(reviewBadgeVariant({ ...summary, state: "pending" })).toBe("info");
  });

  it("formats locations", () => {
    expect(findingLocation({ file: "a.ts", line: 3 })).toBe("a.ts:3");
    expect(findingLocation({ file: "a.ts", line: null })).toBe("a.ts");
    expect(findingLocation({ file: null, line: 3 })).toBeNull();
  });

  it("shows earlier rounds' open findings only, sorted open gating first", () => {
    const r = review([
      finding("R1.1", { severity: "nit" }),
      finding("R1.2", { severity: "blocking", status: "fixed" }),
      finding("R1.3", { severity: "major" }),
    ]);
    expect(visibleFindings(r, false).map((f) => f.label)).toEqual(["R1.1", "R1.3"]);
    expect(sortFindings(visibleFindings(r, true)).map((f) => f.label)).toEqual(["R1.3", "R1.1", "R1.2"]);
    expect(hasOpenGating(r.findings)).toBe(true);
    expect(hasOpenGating([finding("x", { severity: "blocking", status: "wont_fix" })])).toBe(false);
  });

  it("round-trips the auto-review override", () => {
    for (const value of [null, true, false]) expect(autoReviewValue(autoReviewChoice(value))).toBe(value);
    expect(autoReviewOptions(true)[0]?.label).toBe("Default (on)");
  });

  it("lists built-in, discovered and missing configured skills", () => {
    const found: SkillInfo[] = [
      {
        source: "global",
        name: "review-loop",
        description: null,
        path: "/h/.claude/skills/review-loop/SKILL.md",
        root: "~/.claude/skills",
      },
    ];
    const missing = { source: "project" as const, name: "old", path: "/w/.claude/skills/old/SKILL.md" };
    const options = skillOptions(found, missing, { inheritLabel: "Default" });
    expect(options.map((o) => [o.value, o.detail])).toEqual([
      ["inherit", ""],
      ["builtin", "Built in"],
      ["skill:/h/.claude/skills/review-loop/SKILL.md", "~/.claude/skills"],
      ["skill:/w/.claude/skills/old/SKILL.md", "Not found"],
    ]);
    expect(skillKey(null)).toBe("inherit");
    expect(skillKey({ source: "builtin" })).toBe("builtin");
    expect(skillOptions(found, { source: "builtin" }).map((o) => o.value)).toEqual([
      "builtin",
      "skill:/h/.claude/skills/review-loop/SKILL.md",
    ]);
  });
});
