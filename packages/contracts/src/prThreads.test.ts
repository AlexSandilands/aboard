import { describe, expect, it } from "vitest";
import {
  approvalBlock,
  approvalBlockReason,
  approvalBlockText,
  isStalledPr,
  unansweredThreads,
  type PrReviewThreadInfo,
  type PrSnapshot,
} from "./index.ts";

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

describe("approvalBlock", () => {
  it('is plain "Needs approval" with no unresolved threads, and null for a PR not waiting on an approval', () => {
    expect(approvalBlockText(snapshot({ reviewThreads: [] }))).toBe("Needs approval");
    expect(approvalBlockText(snapshot({ reviewDecision: "approved" }))).toBeNull();
    expect(approvalBlockText(snapshot({ reviewDecision: "changes_requested" }))).toBeNull();
    expect(approvalBlockText(snapshot({ state: "merged" }))).toBeNull();
    expect(approvalBlockText(null)).toBeNull();
  });

  it("names who is waiting on a reply on one thread", () => {
    expect(approvalBlockText(snapshot())).toBe(
      "Needs approval · 1 unresolved review thread (@bob) may be holding it back: 1 waiting on a reply",
    );
  });

  it("splits threads waiting on a reply from ones answered and waiting on the reviewer", () => {
    const s = snapshot({
      reviewThreads: [
        thread("T1", { lastAuthor: "coderabbitai", lastTrusted: false }),
        thread("T2", { ownLast: true, lastAuthor: "me" }),
        thread("T3"),
      ],
    });
    expect(approvalBlock(s)).toEqual({ threads: 3, waiting: 2, answered: 1, authors: ["coderabbitai", "bob"] });
    expect(approvalBlockText(s)).toBe(
      "Needs approval · 3 unresolved review threads (@coderabbitai, @bob) may be holding it back: 2 waiting on a reply, 1 answered and waiting on the reviewer",
    );
    // All answered: nobody is named, since the poll only reads who spoke last.
    expect(approvalBlockText(snapshot({ reviewThreads: [thread("T1", { ownLast: true })] }))).toBe(
      "Needs approval · 1 unresolved review thread may be holding it back: 1 answered and waiting on the reviewer",
    );
  });

  it("names three authors, then how many more, and a deleted account", () => {
    const authors = ["a", "b", "", "d", "e"];
    const s = snapshot({ reviewThreads: authors.map((a, i) => thread(`T${i}`, { lastAuthor: a })) });
    expect(approvalBlockReason(approvalBlock(s))).toBe(
      "5 unresolved review threads (@a, @b, a deleted account and 2 more) may be holding it back: 5 waiting on a reply",
    );
  });

  it("gives only the count for a snapshot stored before the threads were read", () => {
    expect(approvalBlockText(snapshot({ reviewThreads: undefined, unresolvedThreads: 2 }))).toBe(
      "Needs approval · 2 unresolved review threads may be holding it back",
    );
    expect(approvalBlockText(snapshot({ reviewThreads: undefined }))).toBe("Needs approval");
  });
});
