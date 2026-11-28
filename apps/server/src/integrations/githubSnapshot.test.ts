import {
  prCommentReply,
  prFixedReply,
  prFixSessionMarker,
  prReviewHeader,
  prReviewMarker,
  type PrSnapshot,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { fakePr } from "../test/fakeGithub.ts";
import { mapPrSnapshot, mapReviewThreadDetails, pollQuery } from "./githubSnapshot.ts";

const repo = {
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: false,
  autoMergeAllowed: true,
  viewerPermission: "WRITE",
};

const rollup = (...nodes: Array<Record<string, unknown>>) => ({
  nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }],
});
const checkRun = (status: string, conclusion: string) => ({ __typename: "CheckRun", name: "ci", status, conclusion });
const statusContext = (state: string) => ({ __typename: "StatusContext", context: "ci/legacy", state });
const required = <T extends object>(item: T) => ({ ...item, isRequired: true });
const optional = <T extends object>(item: T) => ({ ...item, isRequired: false });

describe("mapPrSnapshot", () => {
  it("maps state, draft, review, mergeable and the merge fields", () => {
    expect(mapPrSnapshot(fakePr({ commits: null, reviewDecision: null }), repo)).toEqual<PrSnapshot>({
      state: "open",
      title: "Add poller",
      checks: "none",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: "feat/poller",
      baseRef: "main",
      updatedAt: "2026-10-01T10:00:00Z",
      autoMerge: null,
      mergeMethods: ["merge", "squash"],
      autoMergeAllowed: true,
      canMerge: true,
      headOid: "head-1",
      isCrossRepository: false,
      reviews: [],
      reviewComments: [],
      reviewThreads: [],
      unresolvedThreads: 0,
      conversationComments: [],
      headCommittedAt: null,
    });
    expect(mapPrSnapshot(fakePr({ isCrossRepository: true }), repo).isCrossRepository).toBe(true);
    expect(mapPrSnapshot(fakePr({ isDraft: true }), repo).state).toBe("draft");
    expect(mapPrSnapshot(fakePr({ state: "MERGED", isDraft: true }), repo).state).toBe("merged");
    expect(mapPrSnapshot(fakePr({ state: "CLOSED" }), repo).state).toBe("closed");
    expect(mapPrSnapshot(fakePr({ reviewDecision: "CHANGES_REQUESTED" }), repo).reviewDecision).toBe(
      "changes_requested",
    );
    expect(mapPrSnapshot(fakePr({ reviewDecision: "REVIEW_REQUIRED" }), repo).reviewDecision).toBe("review_required");
    expect(mapPrSnapshot(fakePr({ mergeable: "CONFLICTING" }), repo).mergeable).toBe("conflicting");
    expect(mapPrSnapshot(fakePr({ mergeable: "UNKNOWN" }), repo).mergeable).toBe("unknown");
    expect(mapPrSnapshot(fakePr({ headRefName: "" }), repo).headRef).toBeNull();
    expect(mapPrSnapshot(fakePr({ autoMergeRequest: { mergeMethod: "SQUASH" } }), repo).autoMerge).toBe("squash");
  });

  it("maps submitted reviews with who wrote them, leaving pending ones out", () => {
    const reviews = {
      nodes: [
        {
          databaseId: 11,
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-10-01T11:00:00Z",
          authorAssociation: "MEMBER",
          viewerDidAuthor: false,
          author: { login: "ana" },
          body: "Please split this up.",
          commit: { oid: "head-0" },
        },
        { databaseId: 12, state: "PENDING", submittedAt: null, viewerDidAuthor: true, author: { login: "me" } },
        null,
        {
          databaseId: 13,
          state: "COMMENTED",
          submittedAt: "2026-10-01T12:00:00Z",
          authorAssociation: "NONE",
          viewerDidAuthor: false,
          author: null,
          body: "  \n",
          commit: { oid: "head-1" },
        },
        {
          databaseId: 14,
          state: "COMMENTED",
          submittedAt: "2026-10-01T13:00:00Z",
          authorAssociation: "OWNER",
          viewerDidAuthor: true,
          author: { login: "me" },
          body: `${prReviewHeader()}\n\nLooks fine.`,
          commit: null,
        },
        {
          databaseId: 15,
          state: "COMMENTED",
          submittedAt: "2026-10-01T14:00:00Z",
          authorAssociation: "OWNER",
          viewerDidAuthor: true,
          author: { login: "me" },
          body: "Can we also rename the flag?",
          commit: { oid: "head-1" },
        },
      ],
    };
    const mapped = mapPrSnapshot(fakePr({ reviews }), repo).reviews;
    expect(mapped).toEqual([
      {
        id: 11,
        author: "ana",
        state: "changes_requested",
        submittedAt: "2026-10-01T11:00:00Z",
        own: false,
        trusted: true,
        hasBody: true,
        marked: false,
        commitOid: "head-0",
      },
      // A reply on a thread: an empty commented review.
      {
        id: 13,
        author: null,
        state: "commented",
        submittedAt: "2026-10-01T12:00:00Z",
        own: false,
        trusted: false,
        hasBody: false,
        marked: false,
        commitOid: "head-1",
      },
      // Autopilot's review, posted as the user: its header carries the mark.
      {
        id: 14,
        author: "me",
        state: "commented",
        submittedAt: "2026-10-01T13:00:00Z",
        own: true,
        trusted: true,
        hasBody: true,
        marked: true,
        commitOid: null,
      },
      // The user's own words.
      {
        id: 15,
        author: "me",
        state: "commented",
        submittedAt: "2026-10-01T14:00:00Z",
        own: true,
        trusted: true,
        hasBody: true,
        marked: false,
        commitOid: "head-1",
      },
    ]);
    // The body itself is never kept.
    expect(JSON.stringify(mapped)).not.toContain("split");
  });

  it("maps the newest conversation comments without their bodies, and the head commit's date", () => {
    const comment = (id: number, extra: Record<string, unknown> = {}) => ({
      databaseId: id,
      createdAt: `2026-10-01T1${id}:00:00Z`,
      authorAssociation: "MEMBER",
      viewerDidAuthor: false,
      author: { login: "ana" },
      body: "Could this use the shared helper?",
      ...extra,
    });
    const comments = {
      nodes: [
        comment(1),
        comment(2, { authorAssociation: "NONE", author: { login: "drive-by" } }),
        comment(3, { viewerDidAuthor: true, authorAssociation: "OWNER", author: { login: "me" }, body: "Rename it" }),
        comment(4, {
          viewerDidAuthor: true,
          author: { login: "me" },
          body: `${prCommentReply()}\n\nFixed in abc1234.`,
        }),
        comment(5, { viewerDidAuthor: true, author: { login: "me" }, body: `${prFixSessionMarker()}\n\nDone.` }),
        null,
        { ...comment(6), databaseId: null },
        comment(7, { author: null, body: null }),
      ],
    };
    const commits = { nodes: [{ commit: { committedDate: "2026-10-01T09:30:00Z", statusCheckRollup: null } }] };
    const snapshot = mapPrSnapshot(fakePr({ comments, commits }), repo);
    expect(snapshot.headCommittedAt).toBe("2026-10-01T09:30:00Z");
    expect(snapshot.conversationComments).toEqual([
      { id: 1, author: "ana", createdAt: "2026-10-01T11:00:00Z", own: false, trusted: true, marked: false },
      { id: 2, author: "drive-by", createdAt: "2026-10-01T12:00:00Z", own: false, trusted: false, marked: false },
      { id: 3, author: "me", createdAt: "2026-10-01T13:00:00Z", own: true, trusted: true, marked: false },
      { id: 4, author: "me", createdAt: "2026-10-01T14:00:00Z", own: true, trusted: true, marked: true },
      { id: 5, author: "me", createdAt: "2026-10-01T15:00:00Z", own: true, trusted: true, marked: true },
      { id: 7, author: null, createdAt: "2026-10-01T17:00:00Z", own: false, trusted: true, marked: false },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("shared helper");
  });

  it("maps comments on unresolved threads, oldest first, with their review", () => {
    const comment = (id: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
      databaseId: id,
      createdAt,
      authorAssociation: "COLLABORATOR",
      viewerDidAuthor: false,
      author: { login: "ana" },
      pullRequestReview: { databaseId: 100 + id },
      ...extra,
    });
    const reviewThreads = {
      nodes: [
        {
          isResolved: false,
          comments: { nodes: [comment(3, "2026-10-01T12:00:00Z"), comment(1, "2026-10-01T10:00:00Z")] },
        },
        { isResolved: true, comments: { nodes: [comment(2, "2026-10-01T11:00:00Z")] } },
        null,
        {
          isResolved: false,
          comments: {
            nodes: [
              comment(4, "2026-10-01T13:00:00Z", { viewerDidAuthor: true, pullRequestReview: null }),
              comment(5, "2026-10-01T14:00:00Z", { authorAssociation: "CONTRIBUTOR", author: null }),
              { ...comment(6, "2026-10-01T15:00:00Z"), databaseId: null },
            ],
          },
        },
      ],
    };
    expect(mapPrSnapshot(fakePr({ reviewThreads }), repo).reviewComments).toEqual([
      { id: 1, author: "ana", createdAt: "2026-10-01T10:00:00Z", reviewId: 101, own: false, trusted: true },
      { id: 3, author: "ana", createdAt: "2026-10-01T12:00:00Z", reviewId: 103, own: false, trusted: true },
      { id: 4, author: "ana", createdAt: "2026-10-01T13:00:00Z", reviewId: null, own: true, trusted: true },
      { id: 5, author: null, createdAt: "2026-10-01T14:00:00Z", reviewId: 105, own: false, trusted: false },
    ]);
  });

  it("asks for the reviews, the newest 10 conversation comments and the newest 30 threads, without thread bodies", () => {
    const { query } = pollQuery([1]);
    expect(query).toContain(
      "reviews(last: 20) { nodes { databaseId state submittedAt authorAssociation viewerDidAuthor author { login } body commit { oid } } }",
    );
    expect(query).toContain(
      "comments(last: 10) { nodes { databaseId createdAt authorAssociation viewerDidAuthor author { login } body } }",
    );
    expect(query).toContain("commit { committedDate statusCheckRollup");
    expect(query).toContain("reviewThreads(last: 30) { nodes { id isResolved viewerCanResolve");
    // Bodies only of reviews and conversation comments, which are one connection each.
    expect(query.match(/\bbody\b/g)).toHaveLength(2);
    // One comments connection per thread, and one for the conversation: each is a request in GitHub's rate-limit
    // cost, and the poll runs often.
    expect(query.match(/comments\(/g)).toHaveLength(2);
  });

  const comment = (id: number, own = false) => ({
    databaseId: id,
    createdAt: `2026-10-01T10:00:0${id % 10}Z`,
    authorAssociation: "MEMBER",
    viewerDidAuthor: own,
    author: { login: own ? "me" : "ana" },
    pullRequestReview: { databaseId: 900 },
  });
  /** A thread opened by a colleague's comment; `reply` is the user's account answering last. */
  const thread = (id: string, reply: string | null, extra: Record<string, unknown> = {}) => {
    const n = Number(id.slice(1));
    return {
      id,
      isResolved: false,
      viewerCanResolve: true,
      root: { nodes: [{ databaseId: n * 10, author: { login: "ana" }, pullRequestReview: { databaseId: 900 } }] },
      comments: { nodes: [comment(n * 10), ...(reply !== null ? [comment(n * 10 + 1, true)] : [])] },
      latest: {
        nodes: [
          reply !== null ? { body: reply, viewerDidAuthor: true } : { body: "Please fix", viewerDidAuthor: false },
        ],
      },
      ...extra,
    };
  };

  it("maps unresolved threads with who spoke last, and leaves out comments on ones the user's account answered", () => {
    const reviewThreads = {
      nodes: [
        thread("T1", prFixedReply("abc1234")),
        thread("T2", null),
        thread("T3", null, { isResolved: true }),
        thread("T4", null, { viewerCanResolve: null }),
        null,
        { ...thread("T5", null), id: null },
      ],
    };
    const snapshot = mapPrSnapshot(fakePr({ reviewThreads }), repo);
    expect(snapshot.reviewThreads).toEqual([
      {
        id: "T1",
        canResolve: true,
        lastCommentId: 11,
        ownLast: true,
        lastReviewId: 900,
        lastAuthor: "me",
        lastTrusted: true,
      },
      {
        id: "T2",
        canResolve: true,
        lastCommentId: 20,
        ownLast: false,
        lastReviewId: 900,
        lastAuthor: "ana",
        lastTrusted: true,
      },
      {
        id: "T4",
        canResolve: false,
        lastCommentId: 40,
        ownLast: false,
        lastReviewId: 900,
        lastAuthor: "ana",
        lastTrusted: true,
      },
    ]);
    expect(snapshot.unresolvedThreads).toBe(4);
    expect(snapshot.reviewComments!.map((c) => c.id)).toEqual([20, 40, 50]);
  });

  it("says whether the newest comment's author has access to the repository, and keeps a deleted one as empty", () => {
    const outsider = { ...comment(60), authorAssociation: "NONE", author: { login: "stranger" } };
    const ghost = { ...comment(70), authorAssociation: "CONTRIBUTOR", author: null };
    const snapshot = mapPrSnapshot(
      fakePr({
        reviewThreads: {
          nodes: [
            { ...thread("T6", null), comments: { nodes: [comment(60), outsider] } },
            { ...thread("T7", null), comments: { nodes: [ghost] } },
            { ...thread("T8", null), comments: { nodes: [] } },
          ],
        },
      }),
      repo,
    );
    expect(snapshot.reviewThreads!.map((t) => [t.id, t.lastAuthor, t.lastTrusted])).toEqual([
      ["T6", "stranger", false],
      ["T7", "", false],
      ["T8", null, false],
    ]);
  });

  it("reads what Autopilot's newest reply says, and whose review opened the thread, on the fresh read", () => {
    const details = mapReviewThreadDetails([
      thread(
        "T1",
        `${prFixedReply("ABC1234")}

Moved the check.`,
      ),
      thread("T2", `${prReviewMarker()} · declined: out of scope`),
      // Written before the format was fixed: the mark, then "Fixed in" on a line of its own.
      thread(
        "T3",
        `${prReviewMarker()}

Fixed in 8bbe435: renamed it.`,
      ),
      thread(
        "T4",
        `${prReviewMarker()} · major

**A point**`,
      ),
      // The user's own words without the mark aren't Autopilot's reply, nor is the mark in someone else's comment.
      thread("T5", "fixed in abc1234"),
      { ...thread("T6", null), latest: { nodes: [{ body: prFixedReply("abc1234"), viewerDidAuthor: false }] } },
    ]);
    expect(
      details.map(({ id, reply, fixedIn, rootCommentId, rootReviewId, rootAuthor, speakers }) => ({
        id,
        rootAuthor,
        speakers,
        reply,
        fixedIn,
        rootCommentId,
        rootReviewId,
      })),
    ).toEqual([
      {
        id: "T1",
        rootAuthor: "ana",
        speakers: ["ana"],
        reply: "fixed",
        fixedIn: "abc1234",
        rootCommentId: 10,
        rootReviewId: 900,
      },
      {
        id: "T2",
        rootAuthor: "ana",
        speakers: ["ana"],
        reply: "declined",
        fixedIn: null,
        rootCommentId: 20,
        rootReviewId: 900,
      },
      {
        id: "T3",
        rootAuthor: "ana",
        speakers: ["ana"],
        reply: "fixed",
        fixedIn: "8bbe435",
        rootCommentId: 30,
        rootReviewId: 900,
      },
      {
        id: "T4",
        rootAuthor: "ana",
        speakers: ["ana"],
        reply: "other",
        fixedIn: null,
        rootCommentId: 40,
        rootReviewId: 900,
      },
      {
        id: "T5",
        rootAuthor: "ana",
        speakers: ["ana"],
        reply: null,
        fixedIn: null,
        rootCommentId: 50,
        rootReviewId: 900,
      },
      {
        id: "T6",
        rootAuthor: "ana",
        speakers: ["ana"],
        reply: null,
        fixedIn: null,
        rootCommentId: 60,
        rootReviewId: 900,
      },
    ]);
  });

  it("maps the repo's merge settings and the viewer's permission", () => {
    const all = { ...repo, rebaseMergeAllowed: true, viewerPermission: "MAINTAIN" };
    expect(mapPrSnapshot(fakePr(), all)).toMatchObject({ mergeMethods: ["merge", "squash", "rebase"], canMerge: true });
    expect(mapPrSnapshot(fakePr(), { ...repo, viewerPermission: "READ" }).canMerge).toBe(false);
    expect(mapPrSnapshot(fakePr(), { ...repo, viewerPermission: "TRIAGE" }).canMerge).toBe(false);
    expect(mapPrSnapshot(fakePr(), { ...repo, viewerPermission: null }).canMerge).toBe(false);
    expect(mapPrSnapshot(fakePr(), { ...repo, autoMergeAllowed: null }).autoMergeAllowed).toBe(false);
  });

  it.each([
    ["empty rollup", [], "none"],
    [
      "all checks green",
      [checkRun("COMPLETED", "SUCCESS"), checkRun("COMPLETED", "SKIPPED"), statusContext("SUCCESS")],
      "passing",
    ],
    ["neutral counts as passing", [checkRun("COMPLETED", "NEUTRAL")], "passing"],
    ["one in progress", [checkRun("COMPLETED", "SUCCESS"), checkRun("IN_PROGRESS", "")], "pending"],
    ["queued check run", [checkRun("QUEUED", "")], "pending"],
    ["pending status context", [statusContext("PENDING")], "pending"],
    ["expected status context", [statusContext("EXPECTED")], "pending"],
    ["failure beats pending", [checkRun("IN_PROGRESS", ""), checkRun("COMPLETED", "FAILURE")], "failing"],
    ["timed out", [checkRun("COMPLETED", "TIMED_OUT")], "failing"],
    ["cancelled", [checkRun("COMPLETED", "CANCELLED")], "failing"],
    ["action required", [checkRun("COMPLETED", "ACTION_REQUIRED")], "failing"],
    ["startup failure", [checkRun("COMPLETED", "STARTUP_FAILURE")], "failing"],
    ["status context error", [checkRun("COMPLETED", "SUCCESS"), statusContext("ERROR")], "failing"],
  ] as const)("checks: %s", (_name, items, expected) => {
    expect(mapPrSnapshot(fakePr({ commits: rollup(...items) }), repo).checks).toBe(expected);
  });
});

describe("required checks", () => {
  const snapshot = (...items: Array<Record<string, unknown>>) =>
    mapPrSnapshot(fakePr({ commits: rollup(...items) }), repo);

  it("ignores an optional queued check once another is required, and counts it aside", () => {
    const s = snapshot(required(checkRun("COMPLETED", "SUCCESS")), optional(checkRun("QUEUED", "")));
    expect(s.checks).toBe("passing");
    expect(s.optionalChecks).toEqual({ pending: 1, failing: 0 });
  });

  it("ignores an optional failure the same way", () => {
    const s = snapshot(required(checkRun("COMPLETED", "SUCCESS")), optional(checkRun("COMPLETED", "FAILURE")));
    expect(s.checks).toBe("passing");
    expect(s.optionalChecks).toEqual({ pending: 0, failing: 1 });
  });

  it("is pending while a required status context is expected, and failing when a required check fails", () => {
    expect(snapshot(required(statusContext("EXPECTED")), optional(checkRun("COMPLETED", "SUCCESS"))).checks).toBe(
      "pending",
    );
    expect(snapshot(required(checkRun("IN_PROGRESS", "")), required(checkRun("COMPLETED", "FAILURE"))).checks).toBe(
      "failing",
    );
    expect(snapshot(required(checkRun("COMPLETED", "SUCCESS")), required(checkRun("IN_PROGRESS", ""))).checks).toBe(
      "pending",
    );
  });

  it("counts every check when none is required, and reports no optional ones", () => {
    const pending = snapshot(optional(checkRun("COMPLETED", "SUCCESS")), optional(checkRun("QUEUED", "")));
    expect(pending.checks).toBe("pending");
    expect(pending.optionalChecks).toBeUndefined();
    expect(snapshot(checkRun("COMPLETED", "FAILURE")).checks).toBe("failing");
  });

  it("leaves optionalChecks out when the optional checks are all green", () => {
    expect(
      snapshot(required(checkRun("COMPLETED", "SUCCESS")), optional(checkRun("COMPLETED", "SUCCESS"))),
    ).not.toHaveProperty("optionalChecks");
  });

  it("maps GitHub's merge state, and reads isRequired for the PR's own number", () => {
    expect(mapPrSnapshot(fakePr({ mergeStateStatus: "CLEAN" }), repo).mergeState).toBe("clean");
    expect(mapPrSnapshot(fakePr({ mergeStateStatus: "HAS_HOOKS" }), repo).mergeState).toBe("has_hooks");
    expect(mapPrSnapshot(fakePr({ mergeStateStatus: "SOMETHING_NEW" }), repo).mergeState).toBe("unknown");
    expect(mapPrSnapshot(fakePr(), repo)).not.toHaveProperty("mergeState");
    const { query } = pollQuery([4, 9]);
    expect(query).toContain("isRequired(pullRequestNumber: $n0)");
    expect(query).toContain("isRequired(pullRequestNumber: $n1)");
    expect(query).toContain("mergeStateStatus");
  });
});

describe("a check's newest run", () => {
  const run = (name: string, databaseId: number, conclusion: string, workflow: number | null = 1) => ({
    __typename: "CheckRun",
    name,
    databaseId,
    status: "COMPLETED",
    conclusion,
    checkSuite: { workflowRun: workflow === null ? null : { workflow: { databaseId: workflow } } },
  });
  const snapshot = (...items: Array<Record<string, unknown>>) =>
    mapPrSnapshot(fakePr({ commits: rollup(...items) }), repo);

  it("counts a superseded cancelled run as replaced by the newer successful one", () => {
    expect(
      snapshot(required(run("commitlint", 1, "CANCELLED")), required(run("commitlint", 2, "SUCCESS"))).checks,
    ).toBe("passing");
    // Order in the rollup doesn't matter: the highest id wins.
    expect(
      snapshot(required(run("commitlint", 2, "SUCCESS")), required(run("commitlint", 1, "CANCELLED"))).checks,
    ).toBe("passing");
  });

  it("fails when the newest run failed after an older success", () => {
    expect(snapshot(required(run("ci", 1, "SUCCESS")), required(run("ci", 2, "FAILURE"))).checks).toBe("failing");
  });

  it("counts a same-named job in another workflow separately", () => {
    expect(snapshot(required(run("build", 5, "SUCCESS", 1)), required(run("build", 3, "FAILURE", 2))).checks).toBe(
      "failing",
    );
  });

  it("tells workflowless runs apart by app", () => {
    const byApp = (name: string, databaseId: number, conclusion: string, app: number) => ({
      ...run(name, databaseId, conclusion, null),
      checkSuite: { app: { databaseId: app }, workflowRun: null },
    });
    expect(
      snapshot(required(byApp("build", 1, "FAILURE", 10)), required(byApp("build", 2, "SUCCESS", 20))).checks,
    ).toBe("failing");
    expect(
      snapshot(required(byApp("build", 1, "FAILURE", 10)), required(byApp("build", 2, "SUCCESS", 10))).checks,
    ).toBe("passing");
  });

  it("falls back to the name alone when a run has no workflow", () => {
    expect(snapshot(required(run("lint", 1, "FAILURE", null)), required(run("lint", 2, "SUCCESS", null))).checks).toBe(
      "passing",
    );
  });

  it("counts differently named checks each, and never drops unnamed runs or status contexts", () => {
    expect(snapshot(required(run("a", 1, "SUCCESS")), required(run("b", 2, "FAILURE"))).checks).toBe("failing");
    const unnamed = { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" };
    expect(snapshot(required(run("a", 1, "SUCCESS")), required(unnamed)).checks).toBe("failing");
    expect(snapshot(required(run("a", 1, "SUCCESS")), required(statusContext("FAILURE"))).checks).toBe("failing");
  });

  it("ignores whether a superseded run was required or optional", () => {
    const optionalOld = snapshot(required(run("ci", 2, "SUCCESS")), optional(run("ci", 1, "FAILURE")));
    expect(optionalOld.checks).toBe("passing");
    expect(optionalOld).not.toHaveProperty("optionalChecks");
    const requiredOld = snapshot(required(run("ci", 1, "CANCELLED")), optional(run("ci", 2, "SUCCESS")));
    expect(requiredOld.checks).toBe("passing");
    expect(requiredOld).not.toHaveProperty("optionalChecks");
  });
});

describe("pollQuery", () => {
  it("asks for each check run's name, id and workflow", () => {
    expect(pollQuery([4]).query).toContain(
      "name databaseId checkSuite { app { databaseId } workflowRun { workflow { databaseId } } }",
    );
  });

  it("aliases each PR and passes numbers as variables", () => {
    const { query, variables } = pollQuery([4, 9]);
    expect(query).toContain("query PollPullRequests($owner: String!, $name: String!, $n0: Int!, $n1: Int!)");
    expect(query).toContain("pr0: pullRequest(number: $n0)");
    expect(query).toContain("pr1: pullRequest(number: $n1)");
    expect(variables).toEqual({ n0: 4, n1: 9 });
  });
});
