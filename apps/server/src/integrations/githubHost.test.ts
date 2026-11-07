import {
  GITHUB_HOST,
  prFixedReply,
  prReviewHeader,
  type AppSettings,
  type PrSnapshot,
  type TaskLink,
  type TaskStatus,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createFakeGithub, createGithubStack, fakePr } from "../test/fakeGithub.ts";
import { defaultSettings } from "../test/fixtures.ts";
import { GhError, type RunGh } from "./gh.ts";
import { isTransientHostError, StaleReviewError } from "./gitHost.ts";
import { GithubApiError } from "./githubApi.ts";
import { mapPrSnapshot } from "./githubSnapshot.ts";
import { MergeTargetError } from "./prMerge.ts";
import type { PrPollerServices } from "./prPoller.ts";
import type { LinkSnapshot, TasksService } from "../services/types.ts";

/** The services the poller and the merges read. */
type GithubServices = PrPollerServices & { tasks: Pick<TasksService, "summary"> };

const rollup = (...nodes: Array<Record<string, unknown>>) => ({
  nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }],
});

const checkRun = (status: string, conclusion: string) => ({ __typename: "CheckRun", name: "ci", status, conclusion });

const repo = {
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: false,
  autoMergeAllowed: true,
  viewerPermission: "WRITE",
};

describe("GitHub's hosts", () => {
  it("knows GitHub hosts, and others once gh is signed in to them", async () => {
    expect(GITHUB_HOST.claimsHost("github.com")).toBe(true);
    expect(GITHUB_HOST.claimsHost("example.ghe.com")).toBe(true);
    expect(GITHUB_HOST.claimsHost("github.example.com")).toBe(true);
    expect(GITHUB_HOST.claimsHost("code.acme.com")).toBe(false);
    expect(GITHUB_HOST.claimsHost("mygithub.com")).toBe(false);
    const gh = createFakeGithub({ hosts: ["code.acme.com"] });
    const { host } = createGithubStack({ services: () => fakeServices([]).services, runGh: gh.runGh });
    expect(host.claims("code.acme.com")).toBe(false);
    await host.checkStatus();
    expect(host.claims("code.acme.com")).toBe(true);
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
  const snapshots = new Map<string, LinkSnapshot | null>();
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
  const github = createGithubStack({ services: () => services, runGh: gh.runGh, fetch: gh.fetch, log });
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
      kind: "github",
      available: true,
      version: "2.96.0",
      authenticated: true,
      error: null,
      accounts: [
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
    expect(none.github.status()).toMatchObject({ available: true, authenticated: false, accounts: [] });
  });

  it("falls back to `gh auth status` when gh is too old for --json, trusting it for github.com only", async () => {
    const gh = createFakeGithub();
    gh.prs.set("o/r#1", fakePr());
    gh.prs.set("team/svc#3", fakePr());
    const runGh: RunGh = async (args, opts) => {
      if (args.includes("--json")) throw new GhError("unknown flag: --json", false);
      return gh.runGh(args, opts);
    };
    const links = [ghLink("l1", 1), ghLink("ghe", 3, "github.evil.example", "team/svc")];
    const { services, snapshots } = fakeServices(links);
    const github = createGithubStack({ services: () => services, runGh, fetch: gh.fetch });
    expect(await github.checkStatus()).toEqual({
      kind: "github",
      available: true,
      version: "2.96.0",
      authenticated: true,
      error: null,
      accounts: [],
    });
    await github.pollAll();
    expect([...snapshots.keys()]).toEqual(["l1"]);
    expect(gh.requests.map((r) => r.url)).toEqual(["https://api.github.com/graphql"]);
    await expect(github.refresh(links[1]!)).rejects.toThrow(/not signed in to github\.evil\.example/);
    expect(github.holdsTasks("github.com")).toBe(true);
    expect(github.holdsTasks("github.evil.example")).toBe(false);
  });

  it("holds tasks back only for github.com and polled hosts", async () => {
    const { github } = setup([], { hosts: ["github.com", "ghe.example.com"] });
    expect(github.holdsTasks("github.com")).toBe(true);
    expect(github.holdsTasks("ghe.example.com")).toBe(false);
    await github.checkStatus();
    expect(github.holdsTasks("GHE.example.com")).toBe(true);
    expect(github.holdsTasks("github.other.com")).toBe(false);
    expect(github.holdsTasks("example.com")).toBe(false);
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
    const github = createGithubStack({ services: () => services, runGh });
    expect(await github.checkStatus()).toMatchObject({
      authenticated: true,
      accounts: [
        { host: "github.com", authenticated: true },
        { host: "ghe.example.com", authenticated: false },
      ],
    });
  });

  it("reports gh missing", async () => {
    const { services } = fakeServices([]);
    const github = createGithubStack({
      services: () => services,
      runGh: async () => {
        throw new GhError("gh CLI not found", true);
      },
    });
    expect(await github.checkStatus()).toEqual({
      kind: "github",
      available: false,
      version: null,
      authenticated: false,
      error: "gh CLI not found",
      accounts: [],
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
    const github = createGithubStack({
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

describe("github poller schedule", () => {
  const idle = (id: string, number: number, syncedAgoMs: number, over: Partial<PrSnapshot> = {}): PrLink => ({
    ...ghLink(id, number),
    syncedAt: new Date(Date.now() - syncedAgoMs).toISOString(),
    snapshot: { ...mapPrSnapshot(fakePr({ number }), repo), updatedAt: "2026-10-01T10:00:00Z", ...over },
  });
  const fakes = (gh: ReturnType<typeof createFakeGithub>, ...numbers: number[]) =>
    numbers.forEach((n) => gh.prs.set(`o/r#${n}`, fakePr({ number: n })));

  it("polls only the PRs that are due, each at its own tier", async () => {
    const links = [
      ghLink("new", 1),
      idle("pending", 2, 25_000, { checks: "pending" }),
      idle("pending-fresh", 3, 5_000, { checks: "pending" }),
      idle("warm-fresh", 4, 60_000),
      idle("warm-due", 5, 125_000),
      idle("merged", 6, 10 * 60_000, { state: "merged" }),
      idle("merged-due", 7, 31 * 60_000, { state: "merged" }),
    ];
    const { gh, github, snapshots } = setup(links);
    fakes(gh, 1, 2, 3, 4, 5, 6, 7);
    await github.pollAll();
    expect([...snapshots.keys()].sort()).toEqual(["merged-due", "new", "pending", "warm-due"]);
    expect(gh.requests).toHaveLength(1);
  });

  it("leaves a PR GitHub can't find, and a refused host, alone until the warm interval", async () => {
    const { gh, github, warnings } = setup([ghLink("bad", 404)]);
    await github.pollAll();
    await github.pollAll();
    expect(gh.requests).toHaveLength(1);
    await github.pollAll(Date.now() + 2 * 60_000);
    expect(gh.requests).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it("reads a PR link that was just added, and only when polling is on", async () => {
    const link = ghLink("l1", 7);
    const on = setup([link]);
    fakes(on.gh, 7);
    await on.github.pollLink("l1");
    expect(on.snapshots.has("l1")).toBe(true);
    await on.github.pollLink("nope");
    expect(on.gh.requests).toHaveLength(1);

    const off = setup([link], { settings: { githubPolling: false } });
    await off.github.pollLink("l1");
    expect(off.gh.requests).toEqual([]);
  });

  it("reads a task's PRs when its panel opens only if the last read is older than 15 seconds", async () => {
    const other = { ...idle("other-task", 9, 60_000), taskId: "t2" };
    const { gh, github, snapshots } = setup([idle("stale", 1, 20_000), idle("fresh", 2, 5_000), other]);
    fakes(gh, 1, 2, 9);
    await github.viewTask("t1");
    expect([...snapshots.keys()]).toEqual(["stale"]);
    await github.viewTask("t1");
    expect(gh.requests).toHaveLength(2);
  });

  it("doesn't ask again from a panel or a new link while a PR is backed off", async () => {
    const link = { ...ghLink("bad", 404), taskId: "t1" };
    const { gh, github } = setup([link]);
    await github.pollAll();
    expect(gh.requests).toHaveLength(1);
    await github.viewTask("t1");
    await github.viewTask("t1");
    await github.pollLink("bad");
    expect(gh.requests).toHaveLength(1);
  });

  it("reads a link once when a poll and a panel ask for it at the same time", async () => {
    const link = { ...idle("l1", 1, 60_000), taskId: "t1" };
    const { gh, github } = setup([link]);
    fakes(gh, 1);
    await Promise.all([github.pollAll(Date.now() + 120_000), github.viewTask("t1"), github.pollLink("l1")]);
    expect(gh.requests).toHaveLength(1);
  });

  it("polls an open panel's PRs hot, for a while after it last asked", async () => {
    const { gh, github, snapshots } = setup([idle("quiet", 1, 10_000)]);
    fakes(gh, 1);
    await github.viewTask("t1");
    expect(snapshots.size).toBe(0);
    // Warm would wait two minutes; the panel makes it hot, so it is due 15 seconds on.
    await github.pollAll(Date.now() + 15_000);
    expect(snapshots.has("quiet")).toBe(true);
    snapshots.clear();
    // Past its TTL the panel no longer counts, so the PR is warm again and not due after a minute.
    await github.pollAll(Date.now() + 50_000);
    expect(snapshots.size).toBe(0);
  });
});

describe("github merge into an epic's branch", () => {
  const link = () => ghLink("l1", 7);

  it("merges with a merge commit at the checked head, then refreshes the snapshot", async () => {
    const { gh, github, snapshots } = setup([link()]);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    await github.mergeIntoEpicBranch(link(), { base: "epic/3-checkout", headOid: "head-1" });
    expect(gh.mutations).toEqual([
      {
        operation: "MergePullRequest",
        input: { pullRequestId: "PR_o/r#7", mergeMethod: "MERGE", expectedHeadOid: "head-1" },
      },
    ]);
    expect(snapshots.get("l1")).toMatchObject({ state: "merged", baseRef: "epic/3-checkout" });
  });

  const epicInput = { base: "epic/3-checkout", headOid: "head-1" };
  const methodsSent = (gh: ReturnType<typeof setup>["gh"]) => gh.mutations.map((m) => m.input.mergeMethod);

  it("squashes where the repository allows only squash merges", async () => {
    const { gh, github, snapshots } = setup([link()]);
    gh.repos.set("o/r", { ...repo, mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false });
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).resolves.toEqual({ method: "squash" });
    expect(methodsSent(gh)).toEqual(["SQUASH"]);
    expect(snapshots.get("l1")).toMatchObject({ state: "merged" });
  });

  it("keeps a merge commit where the repository allows one, and a rebase only as the last resort", async () => {
    const { gh, github } = setup([link()]);
    gh.repos.set("o/r", { ...repo, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true });
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).resolves.toEqual({ method: "merge" });
    gh.mutations.length = 0;
    gh.repos.set("o/r", { ...repo, mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: true });
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).resolves.toEqual({ method: "rebase" });
    expect(methodsSent(gh)).toEqual(["REBASE"]);
  });

  it("moves to the next method when GitHub refuses one as not allowed, and not for any other error", async () => {
    const { gh, github } = setup([link()]);
    // The settings say a merge commit is fine; a ruleset on the branch says otherwise.
    gh.repos.set("o/r", { ...repo, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    gh.failNextMutation("Merge commits are not allowed on this repository.");
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).resolves.toEqual({ method: "squash" });
    expect(methodsSent(gh)).toEqual(["MERGE", "SQUASH"]);

    // A ruleset requiring linear history words its refusal of a merge commit differently.
    gh.mutations.length = 0;
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    gh.failNextMutation("Repository rule violations found\n\nThis branch must not contain merge commits.");
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).resolves.toEqual({ method: "squash" });
    expect(methodsSent(gh)).toEqual(["MERGE", "SQUASH"]);

    gh.mutations.length = 0;
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    gh.failNextMutation("Base branch was modified. Review and try the merge again.");
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).rejects.toThrow(/Base branch was modified/);
    expect(methodsSent(gh)).toEqual(["MERGE"]);
  });

  it("throws GitHub's refusal when every allowed method is refused", async () => {
    const { gh, github } = setup([link()]);
    gh.repos.set("o/r", { ...repo, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    gh.failNextMutation("Merge commits are not allowed on this repository.");
    gh.failNextMutation("Squash merges are not allowed on this repository.");
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).rejects.toThrow(
      /Squash merges are not allowed on this repository/,
    );
    expect(methodsSent(gh)).toEqual(["MERGE", "SQUASH"]);
  });

  it("fails with a clear message when the repository allows no merge method", async () => {
    const { gh, github } = setup([link()]);
    gh.repos.set("o/r", { ...repo, mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false });
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    await expect(github.mergeIntoEpicBranch(link(), epicInput)).rejects.toThrow(/allows no merge method/);
    expect(gh.mutations).toEqual([]);
  });

  it("never merges into the default branch, whatever it was asked", async () => {
    const { gh, github } = setup([link()]);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "main" }));
    await expect(github.mergeIntoEpicBranch(link(), { base: "epic/3-checkout", headOid: "head-1" })).rejects.toThrow(
      /never merges into the default branch \(main\)/,
    );
    await expect(github.mergeIntoEpicBranch(link(), { base: "main", headOid: "head-1" })).rejects.toThrow(
      MergeTargetError,
    );
    expect(gh.mutations).toEqual([]);
  });

  it("refuses a PR retargeted elsewhere, or moved past the checked head", async () => {
    const { gh, github } = setup([link()]);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/4-other" }));
    await expect(github.mergeIntoEpicBranch(link(), { base: "epic/3-checkout", headOid: "head-1" })).rejects.toThrow(
      /now merges into epic\/4-other/,
    );
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout", headRefOid: "head-2" }));
    await expect(
      github.mergeIntoEpicBranch(link(), { base: "epic/3-checkout", headOid: "head-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(gh.mutations).toEqual([]);
  });

  it("refreshes the snapshot when it doesn't merge, so the next check sees the new head", async () => {
    const { gh, github, snapshots } = setup([link()]);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout", headRefOid: "head-2" }));
    await expect(github.mergeIntoEpicBranch(link(), { base: "epic/3-checkout", headOid: "head-1" })).rejects.toThrow(
      "moved on to head-2",
    );
    expect(snapshots.get("l1")).toMatchObject({ headOid: "head-2" });
  });
});

describe("github merge into the default branch", () => {
  const link = () => ghLink("l1", 7);
  const input = { base: "main", headOid: "head-1", method: "squash" as const };

  it("merges with the given method at the checked head, then refreshes the snapshot", async () => {
    const { gh, github, snapshots } = setup([link()]);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "main" }));
    await github.mergeIntoDefaultBranch(link(), input);
    expect(gh.mutations).toEqual([
      {
        operation: "MergePullRequest",
        input: { pullRequestId: "PR_o/r#7", mergeMethod: "SQUASH", expectedHeadOid: "head-1" },
      },
    ]);
    expect(snapshots.get("l1")).toMatchObject({ state: "merged", baseRef: "main" });
  });

  it("refuses a PR into any other branch, one retargeted since the poll, or one moved past the checked head", async () => {
    const { gh, github } = setup([link()]);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "epic/3-checkout" }));
    await expect(github.mergeIntoDefaultBranch(link(), { ...input, base: "epic/3-checkout" })).rejects.toThrow(
      MergeTargetError,
    );
    await expect(github.mergeIntoDefaultBranch(link(), input)).rejects.toThrow(/now merges into epic\/3-checkout/);
    gh.prs.set("o/r#7", fakePr({ baseRefName: "main", headRefOid: "head-2" }));
    await expect(github.mergeIntoDefaultBranch(link(), input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(gh.mutations).toEqual([]);
  });
});

describe("review threads", () => {
  it("reads a PR's threads and commits fresh, and resolves one", async () => {
    const { gh, github } = setup([]);
    gh.prs.set("o/r#7", {
      ...fakePr({
        reviewThreads: {
          nodes: [
            {
              id: "T1",
              isResolved: false,
              viewerCanResolve: true,
              comments: { nodes: [] },
              latest: { nodes: [{ body: prFixedReply("abc1234"), viewerDidAuthor: true }] },
            },
          ],
        },
      }),
      history: ["abc1234ffff", "head-1"],
    });
    const ref = { host: "github.com", repo: "o/r", number: 7 };
    expect(await github.reviewThreads(ref)).toEqual({
      headOid: "head-1",
      commits: ["abc1234ffff", "head-1"],
      threads: [
        {
          id: "T1",
          canResolve: true,
          lastCommentId: null,
          ownLast: false,
          lastReviewId: null,
          rootCommentId: null,
          rootReviewId: null,
          reply: "fixed",
          fixedIn: "abc1234",
        },
      ],
    });
    await github.resolveReviewThread("github.com", "T1");
    expect(gh.mutations).toEqual([{ operation: "ResolveReviewThread", input: { threadId: "T1" } }]);
    expect((await github.reviewThreads(ref)).threads).toEqual([]);
    await expect(github.resolveReviewThread("github.com", "nope")).rejects.toThrow(
      /GitHub couldn't resolve the review thread/,
    );
  });
});

describe("the epic's pull request", () => {
  const input = { host: "github.com", repo: "o/r", head: "epic/3-checkout", title: "feat: checkout", body: "Tasks" };

  it("opens a draft from the epic's branch into the default branch, once", async () => {
    const { gh, github } = setup([]);
    gh.prs.set("o/r#1", fakePr());
    expect(await github.ensureEpicPr(input)).toEqual({
      number: 101,
      url: "https://github.com/o/r/pull/101",
      created: true,
    });
    expect(gh.mutations).toEqual([
      {
        operation: "CreatePullRequest",
        input: {
          repositoryId: "R_o/r",
          baseRefName: "main",
          headRefName: "epic/3-checkout",
          title: "feat: checkout",
          body: "Tasks",
          draft: true,
        },
      },
    ]);
    expect(await github.ensureEpicPr(input)).toMatchObject({ number: 101, created: false });
    expect(gh.mutations).toHaveLength(1);
  });

  it("refuses the default branch as the epic's branch, and updates a description", async () => {
    const { gh, github } = setup([]);
    gh.prs.set("o/r#1", fakePr());
    await expect(github.ensureEpicPr({ ...input, head: "main" })).rejects.toThrow(/can't be the default branch/);
    await github.setPrBody({ host: "github.com", repo: "o/r", number: 1 }, "New body");
    expect(gh.mutations).toEqual([
      { operation: "UpdatePullRequestBody", input: { pullRequestId: "PR_o/r#1", body: "New body" } },
    ]);
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

describe("github postReview", () => {
  const ref = { host: "github.com", repo: "o/r", number: 7 };
  const comments = [{ path: "src/a.ts", line: 3, body: "A comment" }];

  it("posts one review as a comment, with its inline threads, against the PR's head", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    const posted = await github.postReview(ref, { reviewedSha: "abcdef1", body: "Summary", comments });
    expect(posted).toEqual({
      id: 901,
      url: "https://github.com/o/r/pull/7#pullrequestreview-901",
      headOid: "abcdef1234567890",
      folded: 0,
    });
    expect(gh.mutations).toEqual([
      {
        operation: "PostPullRequestReview",
        input: {
          pullRequestId: "PR_o/r#7",
          commitOID: "abcdef1234567890",
          event: "COMMENT",
          body: "Summary",
          threads: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "A comment" }],
        },
      },
    ]);
  });

  it("cuts a body that would be too long for GitHub, also after folding the comments in", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    gh.failNextThreadedReview();
    await github.postReview(ref, {
      reviewedSha: "abcdef1",
      body: "x".repeat(50_000),
      comments: [{ path: "a.ts", line: 1, body: "y".repeat(40_000) }],
    });
    const retried = gh.mutations[1]!.input.body as string;
    expect(retried.length).toBeLessThan(65_536);
    expect(retried.endsWith("_…cut off_")).toBe(true);
  });

  it("reads the PR's head commit", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    await expect(github.prHead(ref)).resolves.toBe("abcdef1234567890");
    await expect(github.prHead({ ...ref, number: 404 })).rejects.toThrow(/Could not resolve to a PullRequest/);
  });

  it("posts a review with no inline comments without a threads field", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    await github.postReview(ref, { reviewedSha: "abcdef1234567890", body: "Nothing to fix", comments: [] });
    expect(gh.mutations[0]!.input).not.toHaveProperty("threads");
  });

  it("refuses when the PR's head isn't the commit the reviewer read", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    const refusal = await github
      .postReview(ref, { reviewedSha: "1234567", body: "x", comments })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(StaleReviewError);
    expect(refusal).toMatchObject({ code: "CONFLICT", head: "abcdef1234567890" });
    expect((refusal as Error).message).toContain("abcdef1");
    expect(gh.mutations).toEqual([]);
  });

  it("puts the inline comments in the body when GitHub refuses them", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    gh.failNextThreadedReview();
    const posted = await github.postReview(ref, { reviewedSha: "abcdef1", body: "Summary", comments });
    expect(posted.folded).toBe(1);
    const [, retry] = gh.mutations;
    expect(retry!.input).not.toHaveProperty("threads");
    expect(retry!.input.body).toContain("Summary");
    expect(retry!.input.body).toContain("`src/a.ts:3`");
    expect(retry!.input.body).toContain("A comment");
  });

  describe("when GitHub answers with an error", () => {
    const body = `${prReviewHeader()}\n\nSummary`;
    const internal = "An internal error occurred, please try again.";

    it("counts the review as posted when GitHub created it all the same, without posting again", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      gh.failNextReview(internal, { landed: true });
      const posted = await github.postReview(ref, { reviewedSha: "abcdef1", body, comments: [] });
      expect(posted).toEqual({
        id: 901,
        url: "https://github.com/o/r/pull/7#pullrequestreview-901",
        headOid: "abcdef1234567890",
        folded: 0,
      });
      expect(gh.mutations.map((m) => m.operation)).toEqual(["PostPullRequestReview"]);
    });

    it("counts it as posted also when the review has inline comments, and doesn't fold them in", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      gh.failNextReview(internal, { landed: true });
      const posted = await github.postReview(ref, { reviewedSha: "abcdef1", body, comments });
      expect(posted).toMatchObject({ id: 901, folded: 0 });
      expect(gh.mutations).toHaveLength(1);
    });

    it("fails, labelled as GitHub's, with the kind kept, when no review is there; a transient one isn't folded", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      gh.failNextReview(internal, { landed: false });
      const error = await github.postReview(ref, { reviewedSha: "abcdef1", body, comments }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GithubApiError);
      expect(error).toMatchObject({ kind: "response", message: `GitHub couldn't post the review: ${internal}` });
      expect(isTransientHostError(error)).toBe(true);
      // One post, as it was: not the same review again without its comments.
      expect(gh.mutations.map((m) => m.operation)).toEqual(["PostPullRequestReview"]);
    });

    it("doesn't look for a review after a plain refusal", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      // An earlier review at this head must not stand in for one GitHub refused.
      gh.reviews.set("o/r#7", [{ databaseId: 1, url: "u1", body, oid: "abcdef1234567890" }]);
      gh.failNextMutation("Pull request review thread line must be part of the diff");
      await expect(github.postReview(ref, { reviewedSha: "abcdef1", body, comments: [] })).rejects.toThrow(/line must/);
      expect(gh.requests.map((r) => r.operation)).not.toContain("PullRequestViewerReviews");
    });

    it("ignores an older review of the same head: it isn't the post that failed", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      gh.reviews.set("o/r#7", [
        { databaseId: 1, url: "u1", body, oid: "abcdef1234567890", submittedAt: "2026-01-01T00:00:00Z" },
      ]);
      gh.failNextReview(internal, { landed: false });
      await expect(github.postReview(ref, { reviewedSha: "abcdef1", body, comments: [] })).rejects.toThrow(/internal/);
    });

    it("ignores another commit's review and one with another's text", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      gh.reviews.set("o/r#7", [
        { databaseId: 1, url: "u1", body, oid: "1111111111111111" },
        { databaseId: 2, url: "u2", body: "A review by hand", oid: "abcdef1234567890" },
      ]);
      gh.failNextReview(internal, { landed: false });
      await expect(github.postReview(ref, { reviewedSha: "abcdef1", body, comments: [] })).rejects.toThrow(/internal/);
    });

    it("still puts comments GitHub refuses into the body when no review landed", async () => {
      const { gh, github } = setup([ghLink("l1", 7)]);
      gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
      gh.failNextThreadedReview();
      const posted = await github.postReview(ref, { reviewedSha: "abcdef1", body, comments });
      expect(posted.folded).toBe(1);
    });
  });

  it("labels a refusal as GitHub's", async () => {
    const { gh, github } = setup([ghLink("l1", 7)]);
    gh.prs.set("o/r#7", fakePr({ headRefOid: "abcdef1234567890" }));
    gh.failNextMutation("Pull request review thread line must be part of the diff");
    await expect(github.postReview(ref, { reviewedSha: "abcdef1", body: "x", comments: [] })).rejects.toThrow(
      "GitHub couldn't post the review: Pull request review thread line must be part of the diff",
    );
  });

  it("reports a host gh isn't signed in to, and GitHub's refusal", async () => {
    const { gh, github } = setup([ghLink("l1", 7)], { hosts: [] });
    await expect(
      github.postReview({ ...ref, host: "github.example.com" }, { reviewedSha: "abcdef1", body: "x", comments: [] }),
    ).rejects.toThrow(/not signed in to github\.example\.com/);
    const ok = setup([ghLink("l1", 7)]);
    await expect(ok.github.postReview(ref, { reviewedSha: "abcdef1", body: "x", comments: [] })).rejects.toThrow(
      /Could not resolve to a PullRequest/,
    );
    expect(gh.mutations).toEqual([]);
  });
});
