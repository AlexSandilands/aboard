import type { AppSettings, PrSnapshot, T3ThreadSnapshot, TaskLink, TaskStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createFakeGithub, fakePr } from "../test/fakeGithub.ts";
import { defaultSettings } from "../test/fixtures.ts";
import { GhError, type RunGh } from "./gh.ts";
import { createGithubIntegration, isGithubHost, mapPrSnapshot, pollQuery, type GithubServices } from "./github.ts";

const repo = {
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: false,
  autoMergeAllowed: true,
  viewerPermission: "WRITE",
};

const rollup = (...nodes: Array<Record<string, string>>) => ({
  nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }],
});
const checkRun = (status: string, conclusion: string) => ({ __typename: "CheckRun", name: "ci", status, conclusion });
const statusContext = (state: string) => ({ __typename: "StatusContext", context: "ci/legacy", state });

describe("mapPrSnapshot", () => {
  it("maps state, draft, review, mergeable and the merge fields", () => {
    expect(mapPrSnapshot(fakePr({ commits: null, reviewDecision: null }), repo)).toEqual<PrSnapshot>({
      state: "open",
      title: "Add poller",
      checks: "none",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: "feat/poller",
      updatedAt: "2026-10-01T10:00:00Z",
      autoMerge: null,
      mergeMethods: ["merge", "squash"],
      autoMergeAllowed: true,
      canMerge: true,
      headOid: "head-1",
    });
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

describe("pollQuery", () => {
  it("aliases each PR and passes numbers as variables", () => {
    const { query, variables } = pollQuery([4, 9]);
    expect(query).toContain("query PollPullRequests($owner: String!, $name: String!, $n0: Int!, $n1: Int!)");
    expect(query).toContain("pr0: pullRequest(number: $n0)");
    expect(query).toContain("pr1: pullRequest(number: $n1)");
    expect(variables).toEqual({ n0: 4, n1: 9 });
  });
});

describe("isGithubHost", () => {
  it("knows GitHub hosts, and others once gh is signed in to them", () => {
    expect(isGithubHost("github.com")).toBe(true);
    expect(isGithubHost("example.ghe.com")).toBe(true);
    expect(isGithubHost("github.example.com")).toBe(true);
    expect(isGithubHost("code.acme.com")).toBe(false);
    expect(isGithubHost("mygithub.com")).toBe(false);
    expect(isGithubHost("code.acme.com", [{ host: "code.acme.com", login: "me", authenticated: true }])).toBe(true);
  });
});

type PrLink = Extract<TaskLink, { kind: "pr" }>;

function prLink(id: string, url: string, ref: PrLink["ref"]): PrLink {
  return {
    id,
    taskId: "t1",
    kind: "pr",
    url,
    label: null,
    syncedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ref,
    snapshot: null,
  };
}

const ghLink = (id: string, number: number, host = "github.com", repoName = "o/r") =>
  prLink(id, `https://${host}/${repoName}/pull/${number}`, { host, repo: repoName, number });

function fakeServices(links: TaskLink[], settings: Partial<AppSettings> = {}, taskStatus: TaskStatus = "review") {
  const snapshots = new Map<string, PrSnapshot | T3ThreadSnapshot | null>();
  const services: GithubServices = {
    links: {
      listByKind: (kind) => links.filter((l) => l.kind === kind),
      get: (id) => {
        const link = links.find((l) => l.id === id);
        if (!link) throw new AppError("NOT_FOUND", id);
        return link;
      },
      setSnapshot: (id, snapshot) => void snapshots.set(id, snapshot),
    },
    tasks: { summary: () => ({ status: taskStatus }) as ReturnType<GithubServices["tasks"]["summary"]> },
    settings: {
      get: () => ({ ...defaultSettings, ...settings }),
    },
  };
  return { services, snapshots };
}

const silentLog = () => {
  const warnings: string[] = [];
  return { warnings, log: { warn: (msg: string) => void warnings.push(msg) } };
};

function setup(
  links: TaskLink[],
  opts: { settings?: Partial<AppSettings>; hosts?: string[]; status?: TaskStatus } = {},
) {
  const gh = createFakeGithub(opts.hosts ? { hosts: opts.hosts } : {});
  const { services, snapshots } = fakeServices(links, opts.settings, opts.status);
  const { log, warnings } = silentLog();
  const github = createGithubIntegration({ services: () => services, runGh: gh.runGh, fetch: gh.fetch, log });
  return { gh, github, snapshots, warnings };
}

describe("github poller", () => {
  it("batches PRs per host and repo, and leaves non-GitHub hosts alone", async () => {
    const links = [
      ...Array.from({ length: 30 }, (_, i) => ghLink(`l${i}`, i + 1)),
      ghLink("other", 5, "github.com", "o/other"),
      ghLink("ghe", 3, "ghe.example.com", "team/svc"),
      ghLink("random", 2, "example.com", "a/b"),
      prLink("ado", "https://dev.azure.com/x/_git/y/pullrequest/5", null),
    ];
    const { gh, github, snapshots } = setup(links, { hosts: ["github.com", "ghe.example.com"] });
    for (let n = 1; n <= 30; n++) gh.prs.set(`o/r#${n}`, fakePr({ title: `PR ${n}`, number: n }));
    gh.prs.set("o/other#5", fakePr({ title: "Other" }));
    gh.prs.set("team/svc#3", fakePr({ title: "Enterprise" }));
    await github.pollAll();
    expect(snapshots.size).toBe(32);
    expect(snapshots.get("l0")).toMatchObject({ title: "PR 1", checks: "passing", reviewDecision: "approved" });
    expect(snapshots.get("ghe")).toMatchObject({ title: "Enterprise", canMerge: true });
    expect(snapshots.has("random")).toBe(false);
    expect(snapshots.has("ado")).toBe(false);
    // 30 PRs in o/r is two batches of at most 25.
    expect(gh.requests.map((r) => [r.url, r.variables.name, Object.keys(r.variables).length - 2])).toEqual(
      expect.arrayContaining([
        ["https://api.github.com/graphql", "r", 25],
        ["https://api.github.com/graphql", "r", 5],
        ["https://api.github.com/graphql", "other", 1],
        ["https://ghe.example.com/api/graphql", "svc", 1],
      ]),
    );
    expect(gh.requests).toHaveLength(4);
    expect(github.status()).toEqual({
      available: true,
      authenticated: true,
      error: null,
      hosts: [
        { host: "github.com", login: "me", authenticated: true },
        { host: "ghe.example.com", login: "me", authenticated: true },
      ],
    });
  });

  it("skips GitHub hosts gh isn't signed in to", async () => {
    const { gh, github, snapshots } = setup([ghLink("l1", 1), ghLink("ghe", 3, "ghe.example.com", "team/svc")]);
    gh.prs.set("o/r#1", fakePr());
    gh.prs.set("team/svc#3", fakePr());
    await github.pollAll();
    expect([...snapshots.keys()]).toEqual(["l1"]);
  });

  it("skips when polling is disabled or gh is signed out everywhere", async () => {
    const off = setup([ghLink("l1", 1)], { settings: { githubPolling: false } });
    await off.github.pollAll();
    expect(off.gh.requests).toEqual([]);

    const none = setup([ghLink("l1", 1)], { hosts: [] });
    await none.github.pollAll();
    expect(none.gh.requests).toEqual([]);
    expect(none.github.status()).toMatchObject({ available: true, authenticated: false, hosts: [] });
  });

  it("falls back to `gh auth status` when gh is too old for --json", async () => {
    const runGh: RunGh = async (args) => {
      if (args.includes("--json")) throw new GhError("unknown flag: --json", false);
      return "ok";
    };
    const { services } = fakeServices([]);
    const github = createGithubIntegration({ services: () => services, runGh });
    expect(await github.checkStatus()).toEqual({ available: true, authenticated: true, error: null, hosts: [] });
  });

  it("reads signed-in hosts from gh's output when it exits non-zero", async () => {
    const stdout = JSON.stringify({
      hosts: {
        "github.com": [{ state: "success", active: true, host: "github.com", login: "me" }],
        "ghe.example.com": [{ state: "error", active: true, host: "ghe.example.com", login: "me" }],
      },
    });
    const runGh: RunGh = async (args) => {
      if (args.includes("--json")) throw new GhError("token is invalid", false, stdout);
      return "ok";
    };
    const { services } = fakeServices([]);
    const github = createGithubIntegration({ services: () => services, runGh });
    expect(await github.checkStatus()).toMatchObject({
      authenticated: true,
      hosts: [
        { host: "github.com", authenticated: true },
        { host: "ghe.example.com", authenticated: false },
      ],
    });
  });

  it("reports gh missing", async () => {
    const { services } = fakeServices([]);
    const github = createGithubIntegration({
      services: () => services,
      runGh: async () => {
        throw new GhError("gh CLI not found", true);
      },
    });
    expect(await github.checkStatus()).toEqual({
      available: false,
      authenticated: false,
      error: "gh CLI not found",
      hosts: [],
    });
  });

  it("logs a missing PR once and stores the others in its batch", async () => {
    const { gh, github, snapshots, warnings } = setup([ghLink("bad", 404), ghLink("good", 2)]);
    gh.prs.set("o/r#2", fakePr());
    await github.pollAll();
    await github.pollAll();
    expect(snapshots.has("good")).toBe(true);
    expect(snapshots.has("bad")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not resolve to a PullRequest with the number of 404");
  });

  it("stops polling a rate-limited host for the rest of the poll", async () => {
    // Six repos, six batches: the four in flight at once fail, the last two never go out.
    const links = ["a", "b", "c", "d", "e", "f"].map((r) => ghLink(r, 1, "github.com", `o/${r}`));
    const { services, snapshots } = fakeServices(links);
    const gh = createFakeGithub();
    let calls = 0;
    const { log, warnings } = silentLog();
    const github = createGithubIntegration({
      services: () => services,
      runGh: gh.runGh,
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 429 });
      },
      log,
    });
    await github.pollAll();
    expect(calls).toBe(4);
    expect(snapshots.size).toBe(0);
    expect(warnings).toEqual(["[github] github.com: GitHub API rate limit exceeded on github.com"]);
  });

  it("refresh fetches one PR and ignores links that aren't GitHub PRs", async () => {
    const link = ghLink("l1", 7);
    const { gh, github, snapshots } = setup([link], { settings: { githubPolling: false } });
    gh.prs.set("o/r#7", fakePr({ title: "PR 7" }));
    expect(await github.refresh(link)).toBe(true);
    expect(snapshots.get("l1")).toMatchObject({ title: "PR 7" });
    expect(await github.refresh(prLink("ado", "https://dev.azure.com/x/pullrequest/1", null))).toBe(false);
    expect(await github.refresh(ghLink("random", 1, "example.com"))).toBe(false);
  });

  it("refresh reports a host gh isn't signed in to, and GitHub's errors", async () => {
    const { github } = setup([]);
    await expect(github.refresh(ghLink("ghe", 1, "github.example.com"))).rejects.toThrow(
      /not signed in to github\.example\.com.*gh auth login --hostname github\.example\.com/,
    );
    await expect(github.refresh(ghLink("l1", 404))).rejects.toThrow(
      /Could not fetch PR: Could not resolve to a Repository/,
    );
  });
});

describe("github merge", () => {
  const ready = (overrides = {}) => ({
    ...ghLink("l1", 7),
    snapshot: mapPrSnapshot(fakePr(overrides), repo),
  });

  it("merges with the expected head, then refreshes the snapshot", async () => {
    const link = ready();
    const { gh, github, snapshots } = setup([link]);
    gh.prs.set("o/r#7", fakePr());
    await github.merge(link, { action: "merge", method: "squash" });
    expect(gh.mutations).toEqual([
      {
        operation: "MergePullRequest",
        input: { pullRequestId: "PR_o/r#7", mergeMethod: "SQUASH", expectedHeadOid: "head-1" },
      },
    ]);
    expect(snapshots.get("l1")).toMatchObject({ state: "merged" });
  });

  it("refuses when the head moved since the snapshot, and shows the new head", async () => {
    const link = ready();
    const { gh, github, snapshots } = setup([link]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "head-2" }));
    await expect(github.merge(link, { action: "merge", method: "squash" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("new commits"),
    });
    expect(gh.mutations).toEqual([]);
    expect(snapshots.get("l1")).toMatchObject({ headOid: "head-2" });
  });

  it("surfaces GitHub's error as is", async () => {
    const link = ready();
    const { gh, github } = setup([link]);
    gh.prs.set("o/r#7", fakePr());
    gh.failNextMutation('Required status check "ci" is expected.');
    await expect(github.merge(link, { action: "merge", method: "merge" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: 'Required status check "ci" is expected.',
    });
  });

  it("goes through auto-merge when a merge queue is on", async () => {
    const link = ready();
    const { gh, github } = setup([link]);
    gh.prs.set("o/r#7", fakePr({ isMergeQueueEnabled: true }));
    await github.merge(link, { action: "merge", method: "squash" });
    expect(gh.mutations.map((m) => m.operation)).toEqual(["EnableAutoMerge"]);
  });

  it("turns auto-merge on unless the PR can merge right away", async () => {
    const link = ready({ commits: rollup(checkRun("IN_PROGRESS", "")) });
    const { gh, github, snapshots } = setup([link]);
    gh.prs.set("o/r#7", fakePr({ mergeStateStatus: "BLOCKED" }));
    await github.merge(link, { action: "auto", method: "squash" });
    expect(gh.mutations).toEqual([
      { operation: "EnableAutoMerge", input: { pullRequestId: "PR_o/r#7", mergeMethod: "SQUASH" } },
    ]);
    expect(snapshots.get("l1")).toMatchObject({ autoMerge: "squash" });

    gh.mutations.length = 0;
    gh.prs.set("o/r#7", fakePr({ mergeStateStatus: "UNSTABLE" }));
    await github.merge(link, { action: "auto", method: "squash" });
    expect(gh.mutations.map((m) => m.operation)).toEqual(["MergePullRequest"]);
  });

  it("turns auto-merge off", async () => {
    const link = ready({ autoMergeRequest: { mergeMethod: "SQUASH" } });
    const { gh, github, snapshots } = setup([link]);
    gh.prs.set("o/r#7", fakePr({ autoMergeRequest: { mergeMethod: "SQUASH" } }));
    await github.merge(link, { action: "disable_auto" });
    expect(gh.mutations).toEqual([{ operation: "DisableAutoMerge", input: { pullRequestId: "PR_o/r#7" } }]);
    expect(snapshots.get("l1")).toMatchObject({ autoMerge: null });
  });

  it("refuses tasks not in Review, no permission, disallowed methods and other hosts", async () => {
    const link = ready();
    const notReview = setup([link], { status: "in_progress" });
    await expect(notReview.github.merge(link, { action: "merge", method: "squash" })).rejects.toThrow(/in Review/);

    const { gh, github } = setup([link]);
    await expect(github.merge(link, { action: "merge", method: "rebase" })).rejects.toThrow(/doesn't allow rebase/);
    const readOnly = { ...link, snapshot: { ...link.snapshot, canMerge: false } };
    await expect(github.merge(readOnly, { action: "merge", method: "squash" })).rejects.toThrow(/can't merge/);
    const noSnapshot = { ...link, snapshot: null };
    await expect(github.merge(noSnapshot, { action: "merge", method: "squash" })).rejects.toThrow(/Refresh/);
    await expect(
      github.merge(
        { ...ghLink("x", 1, "example.com"), snapshot: link.snapshot },
        { action: "merge", method: "squash" },
      ),
    ).rejects.toThrow(/Only GitHub/);
    expect(gh.requests).toEqual([]);
  });
});
