import { describe, expect, it } from "vitest";
import type { GithubApi } from "./githubApi.ts";
import { createGithubRepoPrs, mapRepoPr, mapRepoPrChecks, type RepoPrData } from "./githubRepoPrs.ts";

const HEAD = "a".repeat(40);

/** The detail query's answer, shaped as GitHub sends it (recorded, trimmed to what the mapping reads). */
const recorded = (over: Partial<RepoPrData["repository"]["pullRequest"]> = {}): RepoPrData => ({
  viewer: { login: "Owner" },
  repository: {
    pullRequest: {
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      title: "Add the thing",
      state: "OPEN",
      isDraft: false,
      author: { login: "Alice" },
      headRefOid: HEAD,
      headRefName: "feat/thing",
      baseRefName: "main",
      isCrossRepository: false,
      closingIssuesReferences: { nodes: [{ number: 5 }] },
      files: { totalCount: 2, nodes: [{ path: "src/a.ts" }, { path: "pnpm-lock.yaml" }] },
      commits: {
        nodes: [
          { commit: { oid: "b".repeat(40), committedDate: "2026-11-07T09:00:00Z", parents: { totalCount: 1 } } },
          { commit: { oid: HEAD, committedDate: "2026-11-07T10:00:00Z", parents: { totalCount: 2 } } },
        ],
      },
      head: {
        nodes: [
          {
            commit: {
              oid: HEAD,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    // An older failed run of `test`, replaced by a newer green one.
                    {
                      kind: "CheckRun",
                      name: "test",
                      databaseId: 1,
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      completedAt: "2026-11-07T10:05:00Z",
                      isRequired: true,
                      checkSuite: { workflowRun: { workflow: { databaseId: 9 } } },
                    },
                    {
                      kind: "CheckRun",
                      name: "test",
                      databaseId: 2,
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      completedAt: "2026-11-07T10:20:00Z",
                      isRequired: true,
                      checkSuite: { workflowRun: { workflow: { databaseId: 9 } } },
                    },
                    // Not required: its failure doesn't count.
                    {
                      kind: "CheckRun",
                      name: "preview",
                      databaseId: 3,
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      completedAt: "2026-11-07T10:30:00Z",
                      isRequired: false,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      latestReviews: { nodes: [{ author: { login: "Carol" }, state: "COMMENTED", body: "Hm" }] },
      reviews: {
        nodes: [
          {
            databaseId: 7,
            author: { login: "Owner" },
            state: "APPROVED",
            body: "ok",
            submittedAt: "2026-11-07T08:00:00Z",
            commit: { oid: "b".repeat(40) },
          },
        ],
      },
      comments: {
        nodes: [
          {
            id: "IC_1",
            databaseId: 11,
            url: "https://github.com/acme/app/pull/42#issuecomment-11",
            author: { login: "Owner" },
            body: "/autopilot stop",
            createdAt: "2026-11-07T07:00:00Z",
            lastEditedAt: null,
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            id: "T1",
            isResolved: false,
            viewerCanResolve: true,
            comments: {
              nodes: [
                {
                  databaseId: 21,
                  author: { login: "Copilot" },
                  body: "Race here",
                  createdAt: "2026-11-07T10:40:00Z",
                  path: "src/a.ts",
                  line: 4,
                },
              ],
            },
          },
        ],
      },
      timelineItems: {
        nodes: [
          {
            kind: "ReviewDismissedEvent",
            createdAt: "2026-11-07T09:30:00Z",
            previousReviewState: "APPROVED",
            actor: { login: "Alice" },
            review: {
              author: { login: "Owner" },
              body: "ok",
              submittedAt: "2026-11-07T08:00:00Z",
              commit: { oid: "b".repeat(40) },
            },
          },
          // Open issues in this repository that mention the PR count; closed ones and other repositories' don't.
          {
            kind: "CrossReferencedEvent",
            source: { kind: "Issue", number: 50, state: "OPEN", repository: { nameWithOwner: "acme/app" } },
          },
          {
            kind: "CrossReferencedEvent",
            source: { kind: "Issue", number: 51, state: "CLOSED", repository: { nameWithOwner: "acme/app" } },
          },
          {
            kind: "CrossReferencedEvent",
            source: { kind: "Issue", number: 52, state: "OPEN", repository: { nameWithOwner: "acme/other" } },
          },
          {
            kind: "CrossReferencedEvent",
            source: { kind: "PullRequest", number: 53, state: "OPEN", repository: { nameWithOwner: "acme/app" } },
          },
        ],
      },
      ...over,
    },
  },
});

describe("mapRepoPr", () => {
  it("maps a recorded answer, lower-casing logins", () => {
    const pr = mapRepoPr(recorded(), "acme/app", []);
    expect(pr).toMatchObject({
      number: 42,
      author: "alice",
      viewer: "owner",
      state: "open",
      headOid: HEAD,
      baseRef: "main",
      closingIssues: [5],
      referencingIssues: [50],
      files: { total: 2, paths: ["src/a.ts", "pnpm-lock.yaml"] },
      // Only the required check counts, by its newest run.
      checks: { pending: [], failing: [], missing: [], latestAt: "2026-11-07T10:20:00Z" },
    });
    expect(pr.commits.map((c) => c.parents)).toEqual([1, 2]);
    expect(pr.comments[0]).toMatchObject({ id: 11, nodeId: "IC_1", author: "owner", body: "/autopilot stop" });
    expect(pr.threads[0]!.comments[0]).toMatchObject({ id: 21, author: "copilot", path: "src/a.ts", line: 4 });
    expect(pr.dismissals).toEqual([
      {
        createdAt: "2026-11-07T09:30:00Z",
        actor: "alice",
        previousState: "APPROVED",
        review: { author: "owner", body: "ok", submittedAt: "2026-11-07T08:00:00Z", commitOid: "b".repeat(40) },
      },
    ]);
  });

  it("refuses an answer of another shape", () => {
    expect(() => mapRepoPr({ repository: null }, "acme/app", [])).toThrow("unexpected PR shape");
  });
});

describe("mapRepoPrChecks", () => {
  const run = (name: string, status: string, conclusion: string | null, required = false) => ({
    kind: "CheckRun",
    name,
    status,
    conclusion,
    completedAt: status === "COMPLETED" ? "2026-11-07T10:00:00Z" : null,
    isRequired: required,
  });

  it("counts every check when none is required", () => {
    expect(mapRepoPrChecks([run("a", "IN_PROGRESS", null), run("b", "COMPLETED", "FAILURE")], [])).toMatchObject({
      pending: ["a"],
      failing: ["b"],
    });
  });

  it("names a required check from the rulesets that hasn't reported", () => {
    expect(mapRepoPrChecks([run("test", "COMPLETED", "SUCCESS")], ["test", "lint"])).toMatchObject({
      failing: [],
      missing: ["lint"],
    });
  });

  it("treats skipped and neutral runs as green and status contexts by their state", () => {
    const checks = mapRepoPrChecks(
      [
        run("a", "COMPLETED", "SKIPPED"),
        run("b", "COMPLETED", "NEUTRAL"),
        { kind: "StatusContext", context: "ci/legacy", state: "ERROR", createdAt: "2026-11-07T10:00:00Z" },
        { kind: "StatusContext", context: "deploy", state: "PENDING", createdAt: "2026-11-07T10:00:00Z" },
      ],
      [],
    );
    expect(checks).toMatchObject({ failing: ["ci/legacy"], pending: ["deploy"] });
  });
});

describe("unchangedSince", () => {
  const fakeApi = (answers: Record<string, unknown>): GithubApi & { paths: string[] } => {
    const paths: string[] = [];
    return {
      paths,
      graphql: () => Promise.reject(new Error("no graphql")),
      graphqlBatch: () => Promise.reject(new Error("no graphql")),
      rest: async (_host, path) => {
        paths.push(path);
        const key = Object.keys(answers).find((k) => path.endsWith(k));
        if (!key) throw new Error(`unexpected ${path}`);
        return answers[key];
      },
    };
  };
  const ref = { host: "github.com", repo: "acme/app", number: 42 };

  it("is true when every commit since merges another branch in", async () => {
    const api = fakeApi({ "/compare/old...new": { status: "ahead", commits: [{ parents: [1, 2] }] } });
    expect(await createGithubRepoPrs(api).unchangedSince(ref, "old", "new", "main")).toBe(true);
  });

  it("after a rebase, compares the change against the base branch, ignoring where its hunks moved", async () => {
    const patch = (at: number) => `@@ -${at},3 +${at},4 @@\n context\n+added\n`;
    const api = fakeApi({
      "/compare/old...new": { status: "diverged", commits: [{ parents: [1] }] },
      "/compare/main...old": { status: "ahead", files: [{ filename: "a.ts", patch: patch(10) }] },
      "/compare/main...new": { status: "ahead", files: [{ filename: "a.ts", patch: patch(14) }] },
    });
    expect(await createGithubRepoPrs(api).unchangedSince(ref, "old", "new", "main")).toBe(true);
  });

  it("is false when the author changed something", async () => {
    const api = fakeApi({
      "/compare/old...new": { status: "ahead", commits: [{ parents: [1] }] },
      "/compare/main...old": { status: "ahead", files: [{ filename: "a.ts", patch: "+a" }] },
      "/compare/main...new": { status: "ahead", files: [{ filename: "a.ts", patch: "+b" }] },
    });
    expect(await createGithubRepoPrs(api).unchangedSince(ref, "old", "new", "main")).toBe(false);
  });
});
