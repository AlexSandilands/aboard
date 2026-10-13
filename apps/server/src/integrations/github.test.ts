import type { AppSettings, PrSnapshot, T3ThreadSnapshot, TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import {
  createGithubIntegration,
  GhError,
  GhPrJson,
  mapPrSnapshot,
  type GithubServices,
  type RunGh,
} from "./github.ts";

const pr = (overrides: Partial<GhPrJson> = {}): GhPrJson =>
  GhPrJson.parse({
    number: 12,
    title: "Add poller",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    headRefName: "feat/poller",
    updatedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  });

const checkRun = (status: string, conclusion: string) => ({ __typename: "CheckRun", name: "ci", status, conclusion });
const statusContext = (state: string) => ({ __typename: "StatusContext", context: "ci/legacy", state });

describe("mapPrSnapshot", () => {
  it("maps state, draft, review and mergeable", () => {
    expect(mapPrSnapshot(pr())).toEqual<PrSnapshot>({
      state: "open",
      title: "Add poller",
      checks: "none",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: "feat/poller",
      updatedAt: "2026-10-01T10:00:00Z",
    });
    expect(mapPrSnapshot(pr({ isDraft: true })).state).toBe("draft");
    expect(mapPrSnapshot(pr({ state: "MERGED", isDraft: true })).state).toBe("merged");
    expect(mapPrSnapshot(pr({ state: "CLOSED" })).state).toBe("closed");
    expect(mapPrSnapshot(pr({ reviewDecision: "APPROVED" })).reviewDecision).toBe("approved");
    expect(mapPrSnapshot(pr({ reviewDecision: "CHANGES_REQUESTED" })).reviewDecision).toBe("changes_requested");
    expect(mapPrSnapshot(pr({ reviewDecision: "REVIEW_REQUIRED" })).reviewDecision).toBe("review_required");
    expect(mapPrSnapshot(pr({ mergeable: "CONFLICTING" })).mergeable).toBe("conflicting");
    expect(mapPrSnapshot(pr({ mergeable: "UNKNOWN" })).mergeable).toBe("unknown");
    expect(mapPrSnapshot(pr({ headRefName: "" })).headRef).toBeNull();
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
  ] as const)("checks: %s", (_name, rollup, expected) => {
    expect(mapPrSnapshot(pr({ statusCheckRollup: [...rollup] })).checks).toBe(expected);
  });
});

function prLink(id: string, url: string, ref: { host: string; repo: string; number: number } | null): TaskLink {
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

function fakeServices(links: TaskLink[], settings: Partial<AppSettings> = {}) {
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
    settings: {
      get: () => ({ jiraBaseUrl: null, githubPolling: true, t3LinkTarget: "desktop", t3TokenSet: false, ...settings }),
    },
  };
  return { services, snapshots };
}

function fakeGh(handler: (args: string[]) => string | Error) {
  const calls: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runGh: RunGh = async (args) => {
    calls.push(args);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight -= 1;
    const result = handler(args);
    if (result instanceof Error) throw result;
    return result;
  };
  return { runGh, calls, maxInFlight: () => maxInFlight };
}

const silentLog = () => {
  const warnings: string[] = [];
  return { warnings, log: { warn: (msg: string) => void warnings.push(msg) } };
};

describe("github poller", () => {
  const ghOk = (args: string[]) => {
    if (args[0] !== "pr") return "ok";
    const number = Number(args[2]!.split("/").at(-1));
    return JSON.stringify({
      number,
      title: `PR ${number}`,
      state: "OPEN",
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [checkRun("COMPLETED", "SUCCESS")],
      headRefName: "b",
      updatedAt: null,
    });
  };

  it("polls only github.com PR links, with concurrency 4", async () => {
    const links = [
      ...Array.from({ length: 9 }, (_, i) =>
        prLink(`l${i}`, `https://github.com/o/r/pull/${i + 1}/files`, {
          host: "github.com",
          repo: "o/r",
          number: i + 1,
        }),
      ),
      prLink("ado", "https://dev.azure.com/x/_git/y/pullrequest/5", null),
    ];
    const { services, snapshots } = fakeServices(links);
    const gh = fakeGh(ghOk);
    const github = createGithubIntegration({ services: () => services, runGh: gh.runGh, log: silentLog().log });
    await github.pollAll();
    expect(snapshots.size).toBe(9);
    expect(snapshots.get("l0")).toMatchObject({ title: "PR 1", checks: "passing", reviewDecision: "approved" });
    expect(snapshots.has("ado")).toBe(false);
    expect(gh.calls.find((c) => c[0] === "pr")).toEqual([
      "pr",
      "view",
      "https://github.com/o/r/pull/1",
      "--json",
      expect.stringContaining("statusCheckRollup"),
    ]);
    expect(gh.maxInFlight()).toBeLessThanOrEqual(4);
    expect(github.status()).toEqual({ available: true, authenticated: true, error: null });
  });

  it("skips when polling is disabled or gh is unauthenticated", async () => {
    const links = [prLink("l1", "https://github.com/o/r/pull/1", { host: "github.com", repo: "o/r", number: 1 })];
    const off = fakeServices(links, { githubPolling: false });
    const gh1 = fakeGh(ghOk);
    await createGithubIntegration({ services: () => off.services, runGh: gh1.runGh }).pollAll();
    expect(gh1.calls).toEqual([]);

    const on = fakeServices(links);
    const gh2 = fakeGh((args) => (args[0] === "auth" ? new GhError("not logged in", false) : ghOk(args)));
    const github = createGithubIntegration({ services: () => on.services, runGh: gh2.runGh });
    await github.pollAll();
    expect(on.snapshots.size).toBe(0);
    expect(github.status()).toMatchObject({ available: true, authenticated: false });
  });

  it("reports gh missing", async () => {
    const { services } = fakeServices([]);
    const github = createGithubIntegration({
      services: () => services,
      runGh: fakeGh(() => new GhError("gh CLI not found", true)).runGh,
    });
    expect(await github.checkStatus()).toEqual({ available: false, authenticated: false, error: "gh CLI not found" });
  });

  it("logs a persistent per-link error once and keeps polling others", async () => {
    const links = [
      prLink("bad", "https://github.com/o/r/pull/404", { host: "github.com", repo: "o/r", number: 404 }),
      prLink("good", "https://github.com/o/r/pull/2", { host: "github.com", repo: "o/r", number: 2 }),
    ];
    const { services, snapshots } = fakeServices(links);
    const gh = fakeGh((args) =>
      args[2]?.endsWith("/404") ? new GhError("Could not resolve to a PullRequest", false) : ghOk(args),
    );
    const { log, warnings } = silentLog();
    const github = createGithubIntegration({ services: () => services, runGh: gh.runGh, log });
    await github.pollAll();
    await github.pollAll();
    expect(snapshots.has("good")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not resolve");
  });

  it("refresh fetches one PR and ignores non-PR links", async () => {
    const link = prLink("l1", "https://github.com/o/r/pull/7", { host: "github.com", repo: "o/r", number: 7 });
    const { services, snapshots } = fakeServices([link], { githubPolling: false });
    const github = createGithubIntegration({ services: () => services, runGh: fakeGh(ghOk).runGh });
    expect(await github.refresh(link)).toBe(true);
    expect(snapshots.get("l1")).toMatchObject({ title: "PR 7" });
    expect(await github.refresh(prLink("ado", "https://dev.azure.com/x/pullrequest/1", null))).toBe(false);
  });

  it("refresh throws a readable error when gh fails", async () => {
    const link = prLink("l1", "https://github.com/o/r/pull/7", { host: "github.com", repo: "o/r", number: 7 });
    const { services } = fakeServices([link]);
    const github = createGithubIntegration({
      services: () => services,
      runGh: fakeGh((args) => (args[0] === "pr" ? "not json" : "ok")).runGh,
    });
    await expect(github.refresh(link)).rejects.toThrow(/invalid JSON/);
  });
});
