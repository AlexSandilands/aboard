import {
  AUTOPILOT_REVIEW_PRS,
  BRAND,
  currentPrReview,
  prReviewHeader,
  prReviewMarker,
  prReviewOutput,
  type AutopilotEngineSettings,
  type PrReviewIssue,
  type PrSnapshot,
} from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PostReviewInput } from "../../integrations/github.ts";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { GithubActions, Runner, RunnerRequest, RunnerResult } from "../types.ts";
import { earlierReviews, renderReview, reviewHandoff, reviewPrs, reviewTools } from "./reviewPrs.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
const SHA_C = "c3d4e5f60718293a4b5c6d7e8f9012345678a1b2";
const SHA_D = "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3";
const KNOWN = [SHA_A, SHA_B, SHA_C, SHA_D];

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Add the thing",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/thing",
  updatedAt: null,
  headOid: SHA_A,
  ...over,
});

const issue = (severity: PrReviewIssue["severity"], over: Partial<PrReviewIssue> = {}): PrReviewIssue => ({
  severity,
  title: `A ${severity}`,
  file: "src/a.ts",
  line: 3,
  body: "It goes wrong when empty.",
  fyi: false,
  ...over,
});

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

interface Post {
  host: string;
  repo: string;
  number: number;
  input: PostReviewInput;
}

function setup() {
  const requests: RunnerRequest[] = [];
  const posts: Post[] = [];
  let issues: PrReviewIssue[] = [];
  let answer: ((request: RunnerRequest) => unknown) | null = null;
  let hold: Promise<void> | null = null;
  let postError: string | null = null;
  const headIn = (prompt: string) => /at head commit ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "unknown";
  const runner: Runner = {
    start: async (request, update = () => {}): Promise<RunnerResult> => {
      requests.push(request);
      update({ runner: "headless", costUsd: 0.5 });
      if (hold) await hold;
      const output = answer
        ? answer(request)
        : { headSha: headIn(request.prompt), summary: "Looks reasonable.", issues };
      return { runner: "headless", result: null, output };
    },
  };
  const github: GithubActions = {
    postReview: async (ref, input) => {
      posts.push({ ...ref, input });
      if (postError) throw new Error(postError);
      const id = 100 + posts.length;
      const headOid = KNOWN.find((sha) => sha.startsWith(input.reviewedSha)) ?? input.reviewedSha;
      return { id, url: `https://github.com/acme/app/pull/7#pullrequestreview-${id}`, headOid, folded: 0 };
    },
  };
  const h = createTestHarness({ integrations: { automations: [reviewPrs] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    github,
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = s.tasks.create({
    projectId: project.id,
    title: "Add the thing",
    plan,
    links: [{ value: "https://github.com/acme/app/pull/7" }],
  });
  const linkId = () => s.tasks.summary(task.id).links.find((l) => l.kind === "pr")!.id;
  const setPr = (over: Partial<PrSnapshot> = {}) => s.links.setSnapshot(linkId(), snapshot(over));
  const pass = async () => {
    await engine.pass();
    await engine.idle();
  };
  const turnOn = (config?: Record<string, unknown>) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_REVIEW_PRS, {
      mode: "on",
      ...(config ? { config } : {}),
    });
  const runs = () => s.autopilot.runsForTask(task.id).filter((r) => r.automation === AUTOPILOT_REVIEW_PRS);
  const notes = () =>
    s.tasks
      .detail(task.id)
      .events.filter((e) => e.type === "note")
      .map((e) => (e.payload as { text: string }).text);
  return {
    ...h,
    s,
    engine,
    project,
    task,
    requests,
    posts,
    linkId,
    setIssues: (next: PrReviewIssue[]) => (issues = next),
    answerWith: (fn: (request: RunnerRequest) => unknown) => (answer = fn),
    holdRunner: (promise: Promise<void> | null) => {
      hold = promise;
    },
    failPost: (message: string | null) => (postError = message),
    setPr,
    pass,
    turnOn,
    engineSettings: (patch: Partial<AutopilotEngineSettings>) => s.autopilot.updateEngine(patch),
    runs,
    notes,
  };
}

describe("review PRs: triggers", () => {
  it("reviews an open PR once the poller has seen it, and not before", async () => {
    const { requests, setPr, pass, turnOn, runs } = setup();
    turnOn();
    await pass();
    // The link has no snapshot yet: nothing to review.
    expect(requests).toHaveLength(0);
    setPr();
    await pass();
    expect(requests).toHaveLength(1);
    expect(runs()).toHaveLength(1);
  });

  it("does nothing while the automation is off", async () => {
    const { requests, setPr, pass } = setup();
    setPr();
    await pass();
    expect(requests).toHaveLength(0);
  });

  it("skips merged and closed PRs, and drafts unless asked", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    for (const state of ["merged", "closed", "draft"] as const) {
      setPr({ state });
      await pass();
    }
    expect(requests).toHaveLength(0);
    turnOn({ reviewDrafts: true });
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("skips PRs from forks, and PRs with no branch or commit yet", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr({ isCrossRepository: true });
    await pass();
    setPr({ headOid: null });
    await pass();
    setPr({ headRef: null });
    await pass();
    expect(requests).toHaveLength(0);
  });

  it("skips tasks that are Done", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "done" }, "agent");
    await pass();
    expect(requests).toHaveLength(0);
  });

  it("reviews each head commit once, and a new one again as the next round", async () => {
    const { requests, setPr, pass, turnOn, runs } = setup();
    turnOn();
    setPr();
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
    setPr({ headOid: SHA_B });
    await pass();
    await pass();
    expect(requests).toHaveLength(2);
    expect(runs()).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("review round 2 of 3");
  });

  it("waits for a review that is still running, then reviews the latest head with it in view", async () => {
    const { requests, setPr, pass, turnOn, holdRunner, runs, engine } = setup();
    turnOn();
    let release!: () => void;
    holdRunner(new Promise<void>((resolve) => (release = resolve)));
    setPr();
    await engine.pass();
    expect(requests).toHaveLength(1);
    // A push while round 1 is going: no second review beside it.
    setPr({ headOid: SHA_B });
    await engine.pass();
    expect(requests).toHaveLength(1);
    holdRunner(null);
    release();
    await engine.idle();
    await pass();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("review round 2 of 3");
    expect(requests[1]!.prompt).toContain("Earlier reviews");
    expect(runs().filter((r) => r.status === "succeeded")).toHaveLength(2);
  });

  it("stops after the rounds the engine allows for a PR", async () => {
    const { requests, setPr, pass, turnOn, engineSettings } = setup();
    engineSettings({ prReviewRounds: 2 });
    turnOn();
    for (const sha of [SHA_A, SHA_B, SHA_C]) {
      setPr({ headOid: sha });
      await pass();
    }
    expect(requests).toHaveLength(2);
  });

  it("counts a failed review as a round used", async () => {
    const { setPr, pass, turnOn, requests, failPost, engineSettings, runs } = setup();
    engineSettings({ prReviewRounds: 2 });
    turnOn();
    // Round 1 fails after the agent ran: it used its round.
    failPost("GitHub said no");
    setPr();
    await pass();
    failPost(null);
    expect(runs()[0]).toMatchObject({ status: "failed" });
    setPr({ headOid: SHA_B });
    await pass();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("review round 2 of 2");
    // Round limit reached: another head isn't reviewed.
    setPr({ headOid: SHA_C });
    await pass();
    expect(requests).toHaveLength(2);
  });

  it("doesn't count a skipped run as a round", async () => {
    const { s, setPr, pass, turnOn, requests, linkId, task } = setup();
    turnOn();
    // A review that was skipped (the PR moved on) is on the books, and posted nothing.
    const skipped = s.autopilot.record({
      automation: AUTOPILOT_REVIEW_PRS,
      candidate: { dedupeKey: `review:pr:${linkId()}:${SHA_A}`, summary: "review", taskId: task.id },
      dryRun: false,
    })!;
    s.autopilot.start(skipped.id);
    s.autopilot.finish(skipped.id, { status: "skipped", summary: "moved on" });
    setPr({ headOid: SHA_B });
    await pass();
    expect(requests[0]!.prompt).toContain("review round 1 of 3");
  });

  it("records what it would do in dry-run, and starts nothing", async () => {
    const { requests, setPr, pass, turnOn, engineSettings, s, task } = setup();
    engineSettings({ dryRun: true });
    turnOn();
    setPr();
    await pass();
    expect(requests).toHaveLength(0);
    const [run] = s.autopilot.runsForTask(task.id);
    expect(run).toMatchObject({
      dryRun: true,
      status: "skipped",
      summary: "Would review PR #7 at a1b2c3d (round 1 of 3)",
    });
    // Turning dry-run off reviews what it only previewed.
    engineSettings({ dryRun: false });
    await pass();
    expect(requests).toHaveLength(1);
  });
});

describe("review PRs: the agent", () => {
  it("runs read-only on the PR's branch, away from the board, and answers in the verdict's shape", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    const [request] = requests;
    expect(request).toMatchObject({
      access: "read-only",
      workspace: { branch: "feat/thing" },
      boardTools: false,
    });
    expect(request!.outputSchema).toMatchObject({ required: ["headSha", "summary", "issues"] });
    expect(request!.options).toMatchObject({ runner: "headless", budgetUsd: 2 });
  });

  it("can read this PR and nothing else, and can't write to GitHub at all", () => {
    const tools = reviewTools({ host: "github.com", repo: "acme/app", number: 7 });
    expect(tools).toEqual([
      "Bash(gh pr view 7)",
      "Bash(gh pr view 7 *)",
      "Bash(gh pr diff 7)",
      "Bash(gh pr diff 7 *)",
      "Bash(gh api repos/acme/app/pulls/7/comments)",
      "Bash(gh api repos/acme/app/pulls/7/reviews)",
    ]);
    // The only `gh api` rules are exact: no wildcard that a write flag could ride on, and no `gh pr review`.
    expect(tools.filter((t) => t.startsWith("Bash(gh api")).every((t) => !t.includes("*"))).toBe(true);
    expect(tools.some((t) => t.includes("gh pr review"))).toBe(false);
    expect(reviewTools({ host: "github.example.com", repo: "acme/app", number: 9 })).toContain(
      "Bash(gh api repos/acme/app/pulls/9/reviews --hostname github.example.com)",
    );
  });

  it("tells it to post nothing, to treat the PR's text as data and to answer with its findings", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain("Don't post anything to GitHub");
    expect(prompt).toContain("untrusted text");
    expect(prompt).toContain(`head commit ${SHA_A}`);
    expect(prompt).toContain("round 1 of 3");
    expect(prompt).not.toContain("Earlier reviews");
    // Nothing in it asks for a review event: the server decides that.
    expect(prompt).not.toMatch(/APPROVE|REQUEST_CHANGES/);
  });

  it("follows the chosen skill, and uses the built-in one by default", async () => {
    const custom = setup();
    custom.turnOn({ skill: { source: "global", name: "strict-review", path: "/nowhere/strict-review/SKILL.md" } });
    custom.setPr();
    await custom.pass();
    expect(custom.requests[0]!.prompt).toContain('"strict-review" at /nowhere/strict-review/SKILL.md');
    const builtin = setup();
    builtin.turnOn();
    builtin.setPr();
    await builtin.pass();
    expect(builtin.requests[0]!.prompt).toContain("You are an independent reviewer.");
  });

  it("fails the run, flagged, when the answer isn't a review, and posts nothing", async () => {
    const { setPr, pass, turnOn, answerWith, runs, notes, posts } = setup();
    answerWith(() => ({ summary: "no sha" }));
    turnOn();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    expect(runs()[0]!.error).toContain("wasn't a review");
    expect(posts).toEqual([]);
    expect(notes()).toEqual([]);
  });

  it("fails the run, flagged, when GitHub refuses the review (for example a stale checkout)", async () => {
    const { setPr, pass, turnOn, failPost, runs, notes } = setup();
    failPost("The PR's head is a1b2c3d, not the 9999999 the reviewer read");
    turnOn();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true, costUsd: 0.5 });
    expect(runs()[0]!.error).toContain("not the 9999999");
    expect(notes()).toEqual([]);
  });

  it("skips when the PR moved on before the agent started", async () => {
    const { s, setPr, turnOn, runs } = setup();
    turnOn();
    setPr();
    const [candidate] = await reviewPrs.check({
      services: s,
      engine: s.autopilot.engine(),
      now: new Date(),
      projects: s.projects.list().map((project) => ({ project, config: reviewPrs.defaults })),
      board: null,
    });
    expect(candidate).toBeDefined();
    // The head changes between the check and the action.
    setPr({ headOid: SHA_D });
    const result = await reviewPrs.act(candidate!, {
      services: s,
      runner: { start: () => Promise.reject(new Error("must not run")) },
      github: { postReview: () => Promise.reject(new Error("must not post")) },
      engine: s.autopilot.engine(),
      config: reviewPrs.defaults,
      run: { id: "r" } as never,
      actor: "autopilot",
      update: () => {},
    });
    expect(result).toMatchObject({ status: "skipped", summary: "PR #7 moved on to d4e5f60" });
    expect(runs()).toEqual([]);
  });
});

describe("review PRs: the review on GitHub", () => {
  it("posts one review with the product's header, the findings inline and the FYI ones in the summary", async () => {
    const { posts, setPr, pass, turnOn, setIssues } = setup();
    setIssues([
      issue("major", { title: "Empty input crashes", suggestion: "Check for empty first." }),
      issue("minor", { fyi: true, title: "Rename x" }),
      issue("minor", { title: "Unplaced", file: undefined, line: undefined }),
    ]);
    turnOn();
    setPr();
    await pass();
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post).toMatchObject({ host: "github.com", repo: "acme/app", number: 7 });
    expect(post!.input.reviewedSha).toBe(SHA_A);
    expect(post!.input.body.startsWith(prReviewHeader())).toBe(true);
    expect(post!.input.body).toContain(`🤖 ${BRAND.name} Autopilot review`);
    expect(post!.input.body).toContain("Looks reasonable.");
    expect(post!.input.body).toContain("### FYI (no action needed)");
    expect(post!.input.body).toContain("Rename x");
    expect(post!.input.body).toContain("### Points");
    expect(post!.input.body).toContain("Unplaced");
    expect(post!.input.comments).toHaveLength(1);
    expect(post!.input.comments[0]).toMatchObject({ path: "src/a.ts", line: 3 });
    expect(post!.input.comments[0]!.body.startsWith(prReviewMarker())).toBe(true);
    expect(post!.input.comments[0]!.body).toContain("Empty input crashes");
    expect(post!.input.comments[0]!.body).toContain("Suggestion: Check for empty first.");
    // FYI points are never inline.
    expect(post!.input.comments.some((c) => c.body.includes("Rename x"))).toBe(false);
  });

  it("posts a review even when nothing was found", async () => {
    const { posts, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.input.comments).toEqual([]);
    expect(posts[0]!.input.body).toContain("no issues");
  });

  it("renders the round, the commit and the counts under the header", () => {
    const { body } = renderReview(
      { summary: "Fine.", issues: [issue("major"), issue("nit", { fyi: true })] },
      { round: 2, maxRounds: 3, headOid: SHA_B },
    );
    expect(body).toContain("_Round 2 of 3, at `b2c3d4e`: 1 major, 1 FYI_");
  });

  it("keeps the review off the board: a note with the link, and the verdict on the run", async () => {
    const { s, task, setPr, pass, turnOn, runs, notes } = setup();
    turnOn();
    setPr();
    await pass();
    const [run] = runs();
    expect(run).toMatchObject({ status: "succeeded", runner: "headless", costUsd: 0.5, needsAttention: false });
    expect(run!.summary).toBe("Reviewed PR #7 at a1b2c3d (round 1 of 3): no issues; nothing at or above major");
    expect(notes()).toEqual([
      "Autopilot reviewed PR #7 at `a1b2c3d` (round 1 of 3): [review on GitHub](https://github.com/acme/app/pull/7#pullrequestreview-101)",
    ]);
    expect(s.tasks.detail(task.id).reviews).toEqual([]);
    // The run holds the commit in full: the same value the poller's snapshot has.
    expect(prReviewOutput(run!)).toMatchObject({
      kind: "pr_review",
      headOid: SHA_A,
      reviewId: 101,
      handoff: "clean",
    });
  });
});

describe("review PRs: verdict, threshold and hand-off", () => {
  it("counts non-FYI issues by severity and ignores FYI ones", async () => {
    const { setPr, pass, turnOn, setIssues, runs } = setup();
    setIssues([
      issue("major"),
      issue("minor"),
      issue("minor"),
      issue("nit", { fyi: true }),
      issue("blocking", { fyi: true }),
    ]);
    turnOn();
    setPr();
    await pass();
    const out = prReviewOutput(runs()[0]!)!;
    expect(out.counts).toEqual({ blocking: 0, major: 1, minor: 2, nit: 0 });
    expect(out.fyi).toBe(2);
    // Only the major is at or above the default threshold; the FYI blocking one never counts.
    expect(out.actionable).toBe(1);
    expect(out.threshold).toBe("major");
  });

  it("hands over to the fix automation when something at or above the threshold has rounds left", async () => {
    const { setPr, pass, turnOn, setIssues, runs } = setup();
    setIssues([issue("major")]);
    turnOn();
    setPr();
    await pass();
    const [run] = runs();
    expect(prReviewOutput(run!)).toMatchObject({ handoff: "fix", round: 1, maxRounds: 3, actionable: 1 });
    expect(run).toMatchObject({ status: "succeeded", needsAttention: false });
    expect(run!.summary).toContain("1 at or above major to fix");
  });

  it("ends the loop when only minors and nits are left", async () => {
    const { setPr, pass, turnOn, setIssues, runs } = setup();
    setIssues([issue("minor"), issue("nit")]);
    turnOn();
    setPr();
    await pass();
    expect(prReviewOutput(runs()[0]!)).toMatchObject({ handoff: "clean", actionable: 0 });
  });

  it("honours a lower fix threshold from the engine settings", async () => {
    const { setPr, pass, turnOn, setIssues, runs, engineSettings } = setup();
    engineSettings({ prFixThreshold: "minor" });
    setIssues([issue("minor")]);
    turnOn();
    setPr();
    await pass();
    expect(prReviewOutput(runs()[0]!)).toMatchObject({ handoff: "fix", threshold: "minor" });
  });

  it("raises the bar to major on the last round, and says so in the prompt", async () => {
    const { requests, setPr, pass, turnOn, setIssues, runs, engineSettings } = setup();
    engineSettings({ prFixThreshold: "nit", prReviewRounds: 2 });
    turnOn();
    setIssues([issue("nit")]);
    setPr();
    await pass();
    // Round 1 counts a nit.
    expect(prReviewOutput(runs()[0]!)).toMatchObject({ handoff: "fix", threshold: "nit" });
    setIssues([issue("nit"), issue("minor")]);
    setPr({ headOid: SHA_B });
    await pass();
    const last = runs().find((r) => r.dedupeKey.endsWith(SHA_B))!;
    expect(prReviewOutput(last)).toMatchObject({ round: 2, threshold: "major", actionable: 0, handoff: "clean" });
    expect(requests[1]!.prompt).toContain("this is the last round");
  });

  it("gives up on the last round with issues still open: Needs attention and a notification", async () => {
    const { s, task, setPr, pass, turnOn, setIssues, runs, engineSettings } = setup();
    engineSettings({ prReviewRounds: 2 });
    setIssues([issue("major")]);
    turnOn();
    setPr();
    await pass();
    setPr({ headOid: SHA_B });
    await pass();
    const last = runs().find((r) => r.dedupeKey.endsWith(SHA_B))!;
    expect(prReviewOutput(last)).toMatchObject({ handoff: "gave_up", round: 2 });
    expect(last).toMatchObject({ status: "succeeded", needsAttention: true });
    expect(last.summary).toContain("Autopilot gave up on PR #7 after 2 review rounds");
    expect(s.tasks.summary(task.id).attention).toContainEqual(
      expect.objectContaining({ kind: "autopilot", message: expect.stringContaining("gave up") }),
    );
    expect(s.notifications.list().items).toContainEqual(
      expect.objectContaining({ kind: "autopilot_failed", taskId: task.id, title: "Review PRs needs you" }),
    );
  });

  it("puts the earlier reviews and the anti-spiral rules in the prompt from round 2", async () => {
    const { requests, setPr, pass, turnOn, setIssues } = setup();
    setIssues([issue("major"), issue("nit", { fyi: true })]);
    turnOn();
    setPr();
    await pass();
    setIssues([]);
    setPr({ headOid: SHA_B });
    await pass();
    const prompt = requests[1]!.prompt;
    expect(prompt).toContain("review round 2 of 3");
    expect(prompt).toContain("Earlier reviews");
    expect(prompt).toContain(
      "Round 1, at a1b2c3d: https://github.com/acme/app/pull/7#pullrequestreview-101 (review id 101): 1 major, 1 FYI",
    );
    expect(prompt).toContain("regressions");
    expect(prompt).toContain("FYI (no action needed)");
    expect(prompt).toContain("Don't raise again a point that was fixed or that the author declined");
    expect(prompt).not.toContain("this is the last round");
  });
});

describe("review PRs: helpers", () => {
  it("decides the hand-off from the actionable count and the round", () => {
    expect(reviewHandoff(0, 3, 3)).toBe("clean");
    expect(reviewHandoff(2, 1, 3)).toBe("fix");
    expect(reviewHandoff(2, 3, 3)).toBe("gave_up");
  });

  const base = { automation: AUTOPILOT_REVIEW_PRS, status: "succeeded" as const, dryRun: false };
  const output = (linkId: string, round: number, headOid = `sha${round}`) => ({
    kind: "pr_review",
    linkId,
    prUrl: "u",
    headOid,
    round,
    maxRounds: 3,
    reviewUrl: `https://x/${round}`,
    reviewId: round,
    counts: { blocking: 0, major: 0, minor: round, nit: 0 },
    fyi: 0,
    threshold: "major",
    actionable: 0,
    handoff: "clean",
  });

  it("lists earlier reviews oldest first, from the link's finished runs only", () => {
    const found = earlierReviews(
      [
        { ...base, output: output("l1", 2) },
        { ...base, output: output("l2", 1) },
        { ...base, output: output("l1", 1) },
        { ...base, status: "failed" as const, output: output("l1", 3) },
      ],
      "l1",
    );
    expect(found.map((e) => e.round)).toEqual([1, 2]);
  });

  it("offers the fix automation only the newest review, and only while it is of the PR's current head", () => {
    const runs = [
      { ...base, output: output("l1", 1, "old") },
      { ...base, output: output("l1", 2, "new") },
    ];
    expect(currentPrReview(runs, "l1", "new")?.round).toBe(2);
    // The head moved on: no verdict is current, and the older review doesn't stand in for it.
    expect(currentPrReview(runs, "l1", "newer")).toBeNull();
    expect(currentPrReview(runs, "l1", "old")).toBeNull();
    expect(currentPrReview(runs, "other", "new")).toBeNull();
    expect(currentPrReview(runs, "l1", null)).toBeNull();
  });
});
