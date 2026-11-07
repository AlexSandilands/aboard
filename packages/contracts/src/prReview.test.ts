import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_REVIEW_PRS,
  PrReviewRunOutput,
  PrReviewVerdict,
  actionableCount,
  countReviewIssues,
  currentPrReview,
  describeCounts,
  effectiveFixThreshold,
  isCountedReview,
  isReviewOfLink,
  latestPrReview,
  meetsThreshold,
  prReviewDedupeKey,
  prReviewHeader,
  prReviewOutput,
} from "./prReview.ts";
import { BRAND } from "./brand.ts";

describe("PR review verdict", () => {
  it("builds the header from the product's name", () => {
    expect(prReviewHeader()).toBe(`📋 ${BRAND.name} Autopilot review`);
  });

  it("keys one review per link and head commit", () => {
    const key = prReviewDedupeKey("link1", "abc");
    expect(key).toBe("review:pr:link1:abc");
    expect(isReviewOfLink(key, "link1")).toBe(true);
    // A link whose id starts the same isn't the same link.
    expect(isReviewOfLink(key, "link")).toBe(false);
  });

  it("compares severities against the threshold", () => {
    expect(meetsThreshold("blocking", "major")).toBe(true);
    expect(meetsThreshold("major", "major")).toBe(true);
    expect(meetsThreshold("minor", "major")).toBe(false);
    expect(meetsThreshold("nit", "nit")).toBe(true);
  });

  it("raises the bar to at least major on the last round only", () => {
    expect(effectiveFixThreshold("nit", 1, 3)).toBe("nit");
    expect(effectiveFixThreshold("nit", 3, 3)).toBe("major");
    expect(effectiveFixThreshold("minor", 3, 3)).toBe("major");
    expect(effectiveFixThreshold("major", 3, 3)).toBe("major");
    // Already stricter than major: left as it is.
    expect(effectiveFixThreshold("blocking", 3, 3)).toBe("blocking");
  });

  it("counts non-FYI issues and the ones at or above a threshold", () => {
    const issue = (severity: "blocking" | "major" | "minor" | "nit", fyi = false) => ({ severity, title: "t", fyi });
    const { counts, fyi } = countReviewIssues([issue("major"), issue("minor"), issue("minor", true), issue("nit")]);
    expect(counts).toEqual({ blocking: 0, major: 1, minor: 1, nit: 1 });
    expect(fyi).toBe(1);
    expect(actionableCount(counts, "major")).toBe(1);
    expect(actionableCount(counts, "nit")).toBe(3);
    expect(describeCounts(counts)).toBe("1 major, 1 minor, 1 nit");
    expect(describeCounts({ blocking: 0, major: 0, minor: 0, nit: 0 })).toBe("no issues");
  });

  it("parses the agent's answer, and rejects one that isn't a review", () => {
    const ok = { summary: "s", issues: [{ severity: "major", title: "t", fyi: false }] };
    expect(PrReviewVerdict.safeParse(ok).success).toBe(true);
    expect(PrReviewVerdict.safeParse({ summary: "s" }).success).toBe(false);
    expect(PrReviewVerdict.safeParse({ ...ok, issues: [{ severity: "major", title: "", fyi: false }] }).success).toBe(
      false,
    );
    expect(PrReviewVerdict.safeParse({ ...ok, issues: [{ severity: "huge", title: "t", fyi: false }] }).success).toBe(
      false,
    );
  });

  it("reads a verdict only from a finished, real review run", () => {
    const output = {
      kind: "pr_review",
      linkId: "l",
      prUrl: "u",
      headOid: "abc",
      round: 1,
      maxRounds: 3,
      reviewUrl: "https://x",
      reviewId: null,
      counts: { blocking: 0, major: 1, minor: 0, nit: 0 },
      fyi: 0,
      threshold: "major",
      actionable: 1,
      handoff: "fix",
    };
    const run = { automation: AUTOPILOT_REVIEW_PRS, status: "succeeded" as const, dryRun: false, output };
    expect(prReviewOutput(run)?.handoff).toBe("fix");
    expect(prReviewOutput({ ...run, status: "failed" })).toBeNull();
    expect(prReviewOutput({ ...run, dryRun: true })).toBeNull();
    expect(prReviewOutput({ ...run, automation: "other" })).toBeNull();
    expect(prReviewOutput({ ...run, output: null })).toBeNull();
  });
});

describe("currentPrReview with verdicts that cost no round", () => {
  const verdict = (round: number, headOid: string, extra: Partial<PrReviewRunOutput> = {}): PrReviewRunOutput => ({
    kind: "pr_review",
    linkId: "l1",
    prUrl: "https://github.com/o/r/pull/1",
    headOid,
    round,
    maxRounds: 3,
    reviewUrl: "https://github.com/o/r/pull/1#review",
    reviewId: 1,
    counts: { blocking: 0, major: 0, minor: 0, nit: 0 },
    fyi: 0,
    threshold: "major",
    actionable: 0,
    handoff: "clean",
    ...extra,
  });
  const run = (output: PrReviewRunOutput) => ({
    automation: AUTOPILOT_REVIEW_PRS,
    status: "succeeded" as const,
    dryRun: false,
    output,
  });

  it("takes a carried verdict at the new head over the counted one it keeps the round of, newest run first", () => {
    const runs = [
      run(verdict(3, "c", { basis: "conflict_review", carriedFrom: "b" })),
      run(verdict(3, "b", { basis: "carried", carriedFrom: "a" })),
      run(verdict(3, "a")),
      run(verdict(2, "z")),
    ];
    expect(currentPrReview(runs, "l1", "c")?.basis).toBe("conflict_review");
    expect(currentPrReview(runs, "l1", "b")).toBeNull();
    expect(currentPrReview(runs.slice(1), "l1", "b")?.carriedFrom).toBe("a");
    expect(latestPrReview(runs, "l1")?.headOid).toBe("c");
  });

  it("counts only reviews without a basis as rounds", () => {
    expect(isCountedReview(verdict(1, "a"))).toBe(true);
    expect(isCountedReview(verdict(1, "a", { basis: "carried" }))).toBe(false);
  });

  it("parses outputs written before the basis existed", () => {
    expect(PrReviewRunOutput.safeParse(verdict(1, "a")).success).toBe(true);
    expect(PrReviewRunOutput.safeParse({ ...verdict(1, "a"), basis: "other" }).success).toBe(false);
  });
});
