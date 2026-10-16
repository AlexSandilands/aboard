import { describe, expect, it } from "vitest";
import { deriveAttention } from "./derive.ts";
import {
  BOARD_REVIEWER,
  deriveReviewSummary,
  reviewBadgeLabel,
  reviewIsDone,
  reviewWantsAnotherRound,
  type FindingSeverity,
  type FindingStatus,
  type ReviewRoundStatus,
} from "./reviews.ts";

const round = (n: number, status: ReviewRoundStatus = "submitted", cycle = 1, reviewer: string | null = "agent") => ({
  round: n,
  cycle,
  status,
  reviewer,
});
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
      byBoard: false,
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

describe("reviewIsDone", () => {
  const done = (rounds: ReturnType<typeof round>[], findings: ReturnType<typeof finding>[], max = 3) =>
    reviewIsDone(deriveReviewSummary(rounds, findings, max));

  it("is false before any round and while a round is unfinished", () => {
    expect(reviewIsDone(null)).toBe(false);
    expect(done([round(1, "pending")], [])).toBe(false);
    expect(done([round(1), round(2, "running")], [])).toBe(false);
    expect(done([round(1, "failed")], [])).toBe(false);
  });

  it("is false while another round is due", () => {
    expect(done([round(1)], [finding(1, "blocking")])).toBe(false);
    expect(done([round(1)], [finding(1, "blocking", "fixed")])).toBe(false);
  });

  it("is true for a clean round", () => {
    expect(done([round(1)], [])).toBe(true);
    expect(done([round(1)], [finding(1, "nit")])).toBe(true);
  });

  it("is true at the round limit, whether findings are open or fixed but unverified", () => {
    const rounds = [round(1), round(2), round(3)];
    expect(done(rounds, [finding(3, "major")])).toBe(true);
    expect(done(rounds, [finding(3, "major", "fixed")])).toBe(true);
  });
});

describe("deriveAttention for reviews", () => {
  const summary = (state: "stalled" | "stuck" | "failed" | "changes_requested", byBoard = false) => ({
    state,
    round: 3,
    maxRounds: 3,
    open: { blocking: 1, major: 1, minor: 0, nit: 0 },
    byBoard,
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

  it("flags findings from the board's own reviewer, which no agent is looping on", () => {
    expect(deriveAttention([], [], summary("changes_requested", true))).toEqual([
      { kind: "review_unattended", severity: "warning", message: "Board review: 2 to fix" },
    ]);
    const rounds = [round(1, "submitted", 1, BOARD_REVIEWER)];
    expect(deriveReviewSummary(rounds, [finding(1, "major")], 3)?.byBoard).toBe(true);
  });
});
