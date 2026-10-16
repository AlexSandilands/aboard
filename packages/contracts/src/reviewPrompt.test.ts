import { describe, expect, it } from "vitest";
import { reviewFixInstructions, reviewLoopInstructions, reviewerBrief } from "./reviewPrompt.ts";

const task = { number: 7, title: "Add exports" };

describe("review prompts", () => {
  it("inlines the built-in skill and points at a custom one by path", () => {
    const builtin = reviewerBrief({ task, round: 2, skill: { source: "builtin" } });
    expect(builtin).toContain('submit_review(task: "#7", round: 2');
    expect(builtin).toContain("# Local review");

    const path = "/home/me/.claude/skills/review-loop/SKILL.md";
    const custom = reviewerBrief({ task, round: 1, skill: { source: "global", name: "review-loop", path } });
    expect(custom).toContain(`"review-loop" at ${path}`);
    expect(custom).not.toContain("# Local review");
  });

  it("tells the implementer to loop with fresh reviewers and open the PR last", () => {
    const text = reviewLoopInstructions({ task, round: 1, cycleRound: 1, maxRounds: 3, skill: { source: "builtin" } });
    expect(text).toContain("round 1 is open, up to 3 rounds");
    expect(text).toContain('start_review("#7")');
    expect(text.indexOf("open the pull request")).toBeGreaterThan(text.indexOf("resolve_finding"));
    expect(text).toContain("unless the user asked you not to");
    expect(text).toContain("Reviewer brief:");
  });

  it("ends the fix prompt with opening the PR, also after the last round", () => {
    for (const cycleRound of [1, 3]) {
      const text = reviewFixInstructions({ task, round: cycleRound, cycleRound, maxRounds: 3 });
      expect(text.trim().split("\n").at(-1)).toContain("open the pull request now");
    }
  });

  it("counts the round limit per cycle, not across the task's history", () => {
    const text = reviewLoopInstructions({ task, round: 4, cycleRound: 1, maxRounds: 3, skill: { source: "builtin" } });
    expect(text).toContain("round 4 (1 of this review) is open, up to 3 rounds");
    expect(reviewFixInstructions({ task, round: 4, cycleRound: 1, maxRounds: 3 })).toContain('start_review("#7")');
    expect(reviewFixInstructions({ task, round: 6, cycleRound: 3, maxRounds: 3 })).toContain(
      "That was the last review round",
    );
  });
});
