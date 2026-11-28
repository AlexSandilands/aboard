import { describe, expect, it } from "vitest";
import { isStalledPr, unansweredThreads, type PrReviewThreadInfo, type PrSnapshot } from "./index.ts";

const thread = (id: string, over: Partial<PrReviewThreadInfo> = {}): PrReviewThreadInfo => ({
  id,
  canResolve: true,
  lastCommentId: 1,
  ownLast: false,
  lastReviewId: null,
  lastAuthor: "bob",
  lastTrusted: true,
  ...over,
});

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Add the thing",
  checks: "passing",
  reviewDecision: "review_required",
  mergeable: "mergeable",
  headRef: "feat/thing",
  updatedAt: null,
  headOid: "abc",
  reviewThreads: [thread("T1")],
  ...over,
});

describe("unansweredThreads", () => {
  it("leaves out threads the user's account answered last, and says who spoke last on the rest", () => {
    const s = snapshot({
      reviewThreads: [
        thread("T1"),
        thread("T2", { ownLast: true, lastAuthor: "me" }),
        thread("T3", { lastAuthor: "stranger", lastTrusted: false }),
      ],
    });
    expect(unansweredThreads(s)).toEqual([
      { id: "T1", author: "bob", trusted: true },
      { id: "T3", author: "stranger", trusted: false },
    ]);
  });

  it("counts a listed review bot as trusted, and an older snapshot's thread as nobody's", () => {
    const s = snapshot({
      reviewThreads: [
        thread("T1", { lastAuthor: "coderabbitai", lastTrusted: false }),
        { id: "T2", canResolve: true, lastCommentId: 2, ownLast: false, lastReviewId: null },
      ],
    });
    expect(unansweredThreads(s, ["coderabbitai"])).toEqual([
      { id: "T1", author: "coderabbitai", trusted: true },
      { id: "T2", author: null, trusted: false },
    ]);
    expect(unansweredThreads(null)).toEqual([]);
  });
});

describe("isStalledPr", () => {
  it("is a green, mergeable, unapproved open PR with a thread nobody answered", () => {
    expect(isStalledPr(snapshot())).toBe(true);
    expect(isStalledPr(snapshot({ reviewDecision: null }))).toBe(true);
    expect(isStalledPr(snapshot({ reviewDecision: "changes_requested" }))).toBe(true);
  });

  it("isn't one that is red, conflicting, approved, a draft, closed or with every thread answered", () => {
    expect(isStalledPr(snapshot({ checks: "failing" }))).toBe(false);
    expect(isStalledPr(snapshot({ checks: "pending" }))).toBe(false);
    expect(isStalledPr(snapshot({ mergeable: "conflicting" }))).toBe(false);
    expect(isStalledPr(snapshot({ reviewDecision: "approved" }))).toBe(false);
    expect(isStalledPr(snapshot({ state: "draft" }))).toBe(false);
    expect(isStalledPr(snapshot({ state: "merged" }))).toBe(false);
    expect(isStalledPr(snapshot({ reviewThreads: [thread("T1", { ownLast: true })] }))).toBe(false);
    expect(isStalledPr(snapshot({ reviewThreads: undefined }))).toBe(false);
    expect(isStalledPr(null)).toBe(false);
  });
});
