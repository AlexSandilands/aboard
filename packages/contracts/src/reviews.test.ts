import { describe, expect, it } from "vitest";
import { deriveAttention } from "./derive.ts";
import {
  deriveReviewSummary,
  reviewBadgeLabel,
  reviewWantsAnotherRound,
  type FindingSeverity,
  type FindingStatus,
  type ReviewRoundStatus,
} from "./reviews.ts";

const round = (n: number, status: ReviewRoundStatus = "submitted", cycle = 1) => ({ round: n, cycle, status });
const finding = (n: number, severity: FindingSeverity, status: FindingStatus = "open") => ({
  round: n,
  severity,
  status,
});

describe("deriveReviewSummary", () => {
  it("is null before any round", () => {
    expect(deriveReviewSummary([], [], 3)).toBeNull();
  });

  it("reports an unfinished latest round as its own status", () => {
    for (const status of ["pending", "running", "stalled", "failed"] as const) {
      expect(deriveReviewSummary([round(1), round(2, status)], [], 3)?.state).toBe(status);
    }
  });

  it("asks for changes while blocking or major findings are open and rounds remain", () => {
    const summary = deriveReviewSummary([round(1)], [finding(1, "blocking"), finding(1, "minor")], 3);
    expect(summary).toEqual({
      state: "changes_requested",
      round: 1,
      maxRounds: 3,
      open: { blocking: 1, major: 0, minor: 1, nit: 0 },
    });
    expect(reviewWantsAnotherRound(summary)).toBe(true);
    expect(reviewBadgeLabel(summary!)).toBe("1 open");
  });

  it("is stuck when gating findings are still open after the last round", () => {
    const summary = deriveReviewSummary([round(1), round(2), round(3)], [finding(3, "major")], 3);
    expect(summary?.state).toBe("stuck");
    expect(reviewWantsAnotherRound(summary)).toBe(false);
  });

  it("is fixed, not clean, when the latest round's gating findings were resolved but not re-reviewed", () => {
    const summary = deriveReviewSummary(
      [round(1)],
      [finding(1, "blocking", "fixed"), finding(1, "major", "wont_fix")],
      3,
    );
    expect(summary?.state).toBe("fixed");
    expect(reviewWantsAnotherRound(summary)).toBe(true);
  });

  it("is clean when the latest round raised nothing gating and nothing gating is open", () => {
    const findings = [finding(1, "blocking", "fixed"), finding(2, "nit"), finding(2, "minor")];
    const summary = deriveReviewSummary([round(1), round(2)], findings, 3);
    expect(summary?.state).toBe("clean");
    expect(summary?.open).toEqual({ blocking: 0, major: 0, minor: 1, nit: 1 });
  });

  it("applies the round limit per cycle", () => {
    const rounds = [round(1), round(2), round(3), round(4, "submitted", 2)];
    const summary = deriveReviewSummary(rounds, [finding(4, "blocking")], 3);
    expect(summary).toMatchObject({ state: "changes_requested", round: 1 });
  });

  it("counts gating findings left open in earlier rounds", () => {
    const summary = deriveReviewSummary([round(1), round(2)], [finding(1, "blocking")], 3);
    expect(summary?.state).toBe("changes_requested");
  });
});

describe("deriveAttention for reviews", () => {
  const summary = (state: "stalled" | "stuck" | "failed" | "changes_requested") => ({
    state,
    round: 3,
    maxRounds: 3,
    open: { blocking: 1, major: 1, minor: 0, nit: 0 },
  });

  it("flags loops that ended without a clean result", () => {
    expect(deriveAttention([], [], summary("stalled")).map((r) => r.kind)).toEqual(["review_stalled"]);
    expect(deriveAttention([], [], summary("stuck"))).toEqual([
      { kind: "review_stuck", severity: "warning", message: "Review: 2 open after 3 rounds" },
    ]);
    expect(deriveAttention([], [], summary("failed")).map((r) => r.kind)).toEqual(["review_failed"]);
  });

  it("leaves a review mid-loop to the agent", () => {
    expect(deriveAttention([], [], summary("changes_requested"))).toEqual([]);
  });
});
