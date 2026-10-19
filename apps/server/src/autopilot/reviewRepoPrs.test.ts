import {
  AUTOMATION_EXAMPLES,
  CreateCustomAutomationInput,
  REVIEW_PRS_CHECK_SCRIPT,
  bundleToDefinition,
  checkCustomDefinition,
  parseAutomationBundle,
  parseCheckOutput,
  prReviewHeader,
  prReviewMarker,
  type CheckItem,
} from "@repo/contracts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The "Review repo PRs" example (docs/features/autopilot.md#sharing-automations): the bundle is valid, and its check
// script, run against what `gh` would answer, lists the right pull requests.

const bundle = AUTOMATION_EXAMPLES.find((e) => e.id === "review-repo-prs")!.bundle;

describe("Review repo PRs: the bundle", () => {
  it("is a script file that parses and passes the definition check, with its inputs", () => {
    const parsed = parseAutomationBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed).toMatchObject({ ok: true });
    expect(bundle.version).toBe(2);
    expect(bundle.inputs.map((i) => i.name)).toEqual([
      "trusted_logins",
      "max_rounds",
      "max_per_run",
      "review_outside_contributors",
    ]);
    const definition = CreateCustomAutomationInput.parse(bundleToDefinition(bundle, { projectIds: ["p1"] }));
    expect(checkCustomDefinition(definition)).toBeNull();
    expect(definition.action).toMatchObject({
      kind: "agent",
      check: { language: "node", body: REVIEW_PRS_CHECK_SCRIPT },
    });
    expect(definition.trigger).toMatchObject({ schedule: { kind: "minutes", everyMinutes: 5 } });
  });

  it("never approves or requests changes, and tells the reviewer so", () => {
    expect(REVIEW_PRS_CHECK_SCRIPT).not.toMatch(/approve|request-changes/i);
    const { action } = bundle;
    if (action.kind !== "agent") throw new Error("not an agent");
    expect(action.prompt).toContain("--comment");
    expect(action.prompt).toContain(prReviewHeader());
    expect(action.prompt).not.toContain("--approve ");
  });
});

describe("Review repo PRs: the check script", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-repo-prs-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const ME = "octocat";
  const marker = prReviewMarker();
  const HEAD = "a".repeat(40);
  const OLD = "b".repeat(40);

  const review = (over: Record<string, unknown> = {}) => ({
    state: "COMMENTED",
    body: `${marker} review\n\nLooks fine.`,
    submittedAt: "2026-01-02T10:00:00Z",
    commit: { oid: HEAD },
    author: { login: ME },
    ...over,
  });
  const comment = (login: string, body: string, createdAt = "2026-01-03T10:00:00Z") => ({
    body,
    createdAt,
    author: { login },
  });
  const pr = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/shop/pull/${number}`,
    isDraft: false,
    headRefName: `branch-${number}`,
    headRefOid: HEAD,
    author: { login: "sam" },
    authorAssociation: "MEMBER",
    labels: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    ...over,
  });
  const reviews = (...nodes: unknown[]) => ({ nodes });
  const comments = (...nodes: unknown[]) => ({ nodes });

  let stderr = "";

  /** Runs the script as the board does, with `gh` answering from `pullRequests`. */
  function run(pullRequests: unknown[], inputs: Record<string, string> = {}, more = false) {
    const data = {
      viewer: { login: ME },
      repository: { pullRequests: { pageInfo: { hasNextPage: more }, nodes: pullRequests } },
    };
    const scriptFile = join(dir, "check.js");
    const fakeGh = join(dir, "fake-gh.js");
    rmSync(join(dir, "calls.txt"), { force: true });
    writeFileSync(scriptFile, REVIEW_PRS_CHECK_SCRIPT);
    // Preloaded, so the script's own `require("node:child_process")` gets the stand-in `gh`.
    writeFileSync(
      fakeGh,
      `const cp = require("node:child_process");
cp.execFileSync = (file, args) => {
  require("node:fs").appendFileSync(${JSON.stringify(join(dir, "calls.txt"))}, JSON.stringify([file, ...args]) + String.fromCharCode(10));
  if (file !== "gh") throw new Error("ran " + file);
  if (args[0] === "repo") return "acme/shop\\n";
  if (args[0] === "api") return ${JSON.stringify(JSON.stringify({ data }))};
  throw new Error("unexpected gh " + args.join(" "));
};`,
    );
    const context = { automation: "Review repo PRs", project: { id: "p", name: "shop", path: dir }, inputs };
    const result = spawnSync(process.execPath, ["--require", fakeGh, scriptFile], {
      input: JSON.stringify(context),
      encoding: "utf8",
    });
    stderr = result.stderr;
    if (result.status !== 0) throw new Error(`the check exited ${result.status}: ${result.stderr}`);
    const parsed = parseCheckOutput(result.stdout);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.items;
  }
  const numbers = (items: CheckItem[]) => items.map((i) => i["number"]);

  it("lists a pull request with no review, with what the prompt reads", () => {
    const items = run([pr(1)]);
    expect(items).toEqual([
      {
        key: `acme/shop#1:${HEAD.slice(0, 7)}:0`,
        repo: "acme/shop",
        number: 1,
        title: "PR 1",
        url: "https://github.com/acme/shop/pull/1",
        author: "sam",
        branch: "branch-1",
        head: HEAD,
        round: 1,
        requested: false,
      },
    ]);
  });

  it("skips a review at the head commit and reviews again after a push", () => {
    const items = run([
      pr(1, { reviews: reviews(review()) }),
      pr(2, { reviews: reviews(review({ commit: { oid: OLD } })) }),
    ]);
    expect(numbers(items)).toEqual([2]);
    expect(items[0]).toMatchObject({ round: 2, requested: false });
  });

  it("only counts reviews this account posted that carry the marker", () => {
    const items = run([
      pr(1, { reviews: reviews(review({ author: { login: "sam" } })) }),
      pr(2, { reviews: reviews(review({ body: "Looks good to me" })) }),
    ]);
    expect(numbers(items)).toEqual([1, 2]);
  });

  it("skips drafts and the no-autopilot label", () => {
    const items = run([
      pr(1, { isDraft: true }),
      pr(2, { labels: { nodes: [{ name: "no-autopilot" }] } }),
      pr(3, { labels: { nodes: [{ name: "bug" }] } }),
    ]);
    expect(numbers(items)).toEqual([3]);
  });

  it("honours /stop-review from the author, this account or a trusted login, and ignores anyone else's", () => {
    const stop = (login: string) => ({ comments: comments(comment(login, "/stop-review")) });
    const inputs = { trusted_logins: "Lee, kim" };
    const items = run([pr(1, stop("sam")), pr(2, stop(ME)), pr(3, stop("lee")), pr(4, stop("mallory"))], inputs);
    expect(numbers(items)).toEqual([4]);
  });

  it("lets a later /re-review undo /stop-review", () => {
    const items = run([
      pr(1, {
        comments: comments(
          comment("sam", "/stop-review", "2026-01-03T10:00:00Z"),
          comment(ME, "/re-review", "2026-01-04T10:00:00Z"),
        ),
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ requested: true });
  });

  it("reviews again on a trusted /re-review, with the count in the key, but not on a stranger's", () => {
    const reviewed = { reviews: reviews(review()) };
    const items = run(
      [
        pr(1, { ...reviewed, comments: comments(comment("lee", "Thanks!\n/re-review please")) }),
        pr(2, { ...reviewed, comments: comments(comment("mallory", "/re-review")) }),
        // The request is older than the review: answered already.
        pr(3, { ...reviewed, comments: comments(comment("lee", "/re-review", "2026-01-01T10:00:00Z")) }),
      ],
      { trusted_logins: "lee" },
    );
    expect(numbers(items)).toEqual([1]);
    expect(items[0]).toMatchObject({ key: `acme/shop#1:${HEAD.slice(0, 7)}:1`, requested: true });
    expect(items[0]!["round"]).toBe(2);
  });

  it("takes /re-review only from this account and trusted logins, not the PR's author", () => {
    const reviewed = { reviews: reviews(review()) };
    const items = run([pr(1, { ...reviewed, comments: comments(comment("sam", "/re-review")) })], {
      trusted_logins: "lee",
    });
    expect(items).toEqual([]);
  });

  it("ignores commands from deleted accounts, and reads them in any case", () => {
    const ghost = pr(1, {
      author: null,
      authorAssociation: "OWNER",
      comments: comments({ body: "/stop-review", createdAt: "2026-01-03T10:00:00Z", author: null }),
    });
    const shouting = pr(2, { comments: comments(comment("sam", "/STOP-Review")) });
    expect(numbers(run([ghost, shouting]))).toEqual([1]);
  });

  it("honours a /re-review when a pending review has no submit time", () => {
    const pending = review({ submittedAt: null, state: "PENDING", commit: { oid: OLD } });
    const items = run([pr(1, { reviews: reviews(pending, review()), comments: comments(comment(ME, "/re-review")) })]);
    expect(items[0]).toMatchObject({ requested: true });
  });

  it("asks GitHub for this repository's open PRs, and says when there are more than it reads", () => {
    run([pr(1)], {}, true);
    expect(stderr).toContain("More than 50 open PRs");
    const calls = readFileSync(join(dir, "calls.txt"), "utf8")
      .split(String.fromCharCode(10))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]).toEqual(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    expect(calls[1]).toEqual(expect.arrayContaining(["api", "graphql", "owner=acme", "name=shop"]));
    expect(calls[1]!.find((a) => a.startsWith("query="))).toContain("authorAssociation");
  });

  it("matches a command only at the start of a line", () => {
    const items = run([pr(1, { comments: comments(comment("sam", "please don't /stop-review me")) })]);
    expect(numbers(items)).toEqual([1]);
  });

  it("stops automatic reviews at the round limit, but not a /re-review", () => {
    const old = (n: number) => review({ commit: { oid: String(n).repeat(40) } });
    const three = reviews(old(1), old(2), old(3));
    const items = run([
      pr(1, { reviews: three }),
      pr(2, { reviews: three, comments: comments(comment(ME, "/re-review")) }),
    ]);
    expect(numbers(items)).toEqual([2]);
    expect(run([pr(1, { reviews: three })], { max_rounds: "4" })).toHaveLength(1);
  });

  it("doesn't take /stop-review-later or /re-review-this for a command", () => {
    const body = ["/stop-review-later", "/re-review-this"].join(String.fromCharCode(10));
    const items = run([pr(1, { comments: comments(comment("sam", body)) })]);
    expect(numbers(items)).toEqual([1]);
    expect(items[0]).toMatchObject({ requested: false, key: `acme/shop#1:${HEAD.slice(0, 7)}:0` });
  });

  it("reviews only PRs from writers and trusted logins unless asked to take outsiders too", () => {
    const outsider = (login: string) => pr(login.length, { author: { login }, authorAssociation: "NONE" });
    const stranger = outsider("mallory");
    const trustedOutsider = outsider("lee");
    const owner = pr(30, { authorAssociation: "OWNER" });
    const items = run([stranger, trustedOutsider, owner], { trusted_logins: "lee" });
    expect(numbers(items)).toEqual([trustedOutsider.number, 30]);
    expect(numbers(run([stranger], { review_outside_contributors: "true" }))).toEqual([stranger.number]);
  });

  it("starts only a few reviews a run, the newest first", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => pr(n));
    expect(numbers(run(many))).toEqual([1, 2, 3, 4, 5]);
    expect(numbers(run(many, { max_per_run: "2" }))).toEqual([1, 2]);
  });

  it("prints nothing when there is nothing to do", () => {
    expect(run([])).toEqual([]);
    expect(run([pr(1, { reviews: reviews(review()) })])).toEqual([]);
  });
});
