import {
  AUTOPILOT_FIX_PRS,
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
import { StaleReviewError, type PostReviewInput, type ReviewThreadDetail } from "../../integrations/gitHost.ts";
import { fakeHeadMoveGit } from "../../test/fakeHeadMoveGit.ts";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { NO_GIT_HOSTS, type GitHostActions } from "../../integrations/gitHosts.ts";
import { WorktreeHeadError, type Runner, type RunnerRequest, type RunnerResult } from "../types.ts";
import { RUN_SERVER_NAME } from "../../mcp/runTokens.ts";
import {
  CONFLICT_REVIEWS_PER_PR,
  REVIEW_ATTEMPTS,
  earlierReviews,
  renderReview,
  reviewHandoff,
  reviewPrs,
} from "./reviewPrs.ts";
import { fixPrs } from "./fixPrs.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
const SHA_C = "c3d4e5f60718293a4b5c6d7e8f9012345678a1b2";
const SHA_D = "d4e5f60718293a4b5c6d7e8f9012345678a1b2c3";

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
  let runnerError: Error | null = null;
  /** The PR's head on GitHub right now: what the snapshot says, as in the real integration. */
  let live: () => string = () => SHA_A;
  let liveOverride: string | null = null;
  const runner: Runner = {
    start: async (request, update = () => {}): Promise<RunnerResult> => {
      requests.push(request);
      update({ runner: "headless", costUsd: 0.5 });
      if (runnerError) throw runnerError;
      if (hold) await hold;
      const output = answer ? answer(request) : { summary: "Looks reasonable.", issues };
      return { runner: "headless", result: null, output };
    },
  };
  const resolved: string[] = [];
  let threads: ReviewThreadDetail[] = [];
  const gitHosts: GitHostActions = {
    ...NO_GIT_HOSTS,
    reviewThreads: async () => ({ headOid: live(), commits: [], threads }),
    resolveReviewThread: async (_host, id) => {
      resolved.push(id);
    },
    postReview: async (ref, input) => {
      posts.push({ ...ref, input });
      if (postError) throw new Error(postError);
      // As the real one: refuse when the PR's head isn't the commit that was reviewed.
      const headOid = live();
      if (!headOid.startsWith(input.reviewedSha)) throw new StaleReviewError(headOid, input.reviewedSha);
      const id = 100 + posts.length;
      return { id, url: `https://github.com/acme/app/pull/7#pullrequestreview-${id}`, headOid, folded: 0 };
    },
    prHead: async () => live(),
  };
  const h = createTestHarness({ integrations: { automations: [reviewPrs, fixPrs] } });
  const headGit = fakeHeadMoveGit();
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    gitHosts,
    runGit: headGit.runGit,
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
  live = () => {
    if (liveOverride) return liveOverride;
    const link = s.tasks.summary(task.id).links.find((l) => l.kind === "pr");
    return (link?.kind === "pr" && link.snapshot?.headOid) || SHA_A;
  };
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
    failRunner: (error: Error | null) => (runnerError = error),
    setLive: (sha: string | null) => {
      liveOverride = sha;
    },
    setPr,
    pass,
    turnOn,
    engineSettings: (patch: Partial<AutopilotEngineSettings>) => s.autopilot.updateEngine(patch),
    /** Review PRs' board-scope config (rounds) and Fix PRs' (the fix threshold the review applies). */
    prSettings: ({ rounds, fixThreshold }: { rounds?: number; fixThreshold?: string }) => {
      if (rounds !== undefined) s.autopilot.setScope("board", null, AUTOPILOT_REVIEW_PRS, { config: { rounds } });
      if (fixThreshold !== undefined) {
        s.autopilot.setScope("board", null, AUTOPILOT_FIX_PRS, { config: { fixThreshold } });
      }
    },
    runs,
    notes,
    resolved,
    /** Declares how the PR's head got from `from` to `to` (see fakeHeadMoveGit). */
    moveHead: headGit.move,
    gitCalls: headGit.calls,
    setThreads: (next: ReviewThreadDetail[]) => (threads = next),
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
    expect(requests[0]!.label).toBe("Review PRs · PR #7 round 1");
    expect(runs()).toHaveLength(1);
  });

  it("leaves task PRs alone where Your PRs is off, and picks them up again when it is back on", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn({ ownPrs: false });
    setPr();
    await pass();
    expect(requests).toHaveLength(0);
    turnOn({ ownPrs: true });
    await pass();
    expect(requests).toHaveLength(1);
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

  it("waits for the task's local review to finish, then reviews the head", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.settings.update({ autoReview: true });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    // Round 1 is pending, then raised a major: the fixes are still to be reviewed.
    await pass();
    expect(requests).toHaveLength(0);
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    await pass();
    expect(requests).toHaveLength(0);
    // Resolving it makes the board open round 2: still waiting.
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
    expect(s.tasks.summary(task.id).review?.state).toBe("pending");
    await pass();
    expect(requests).toHaveLength(0);
    // A stalled round (no one could run it) holds the PR back too.
    s.reviews.setRoundStatus(s.reviews.list(task.id).at(-1)!.id, "stalled", { actor: "board reviewer" });
    await pass();
    expect(requests).toHaveLength(0);
    // The loop ends clean: the current head is reviewed.
    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    await pass();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain(`head commit ${SHA_A}`);
  });

  it("reviews the PR once the local loop ends at the round limit, stuck or not", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.settings.update({ autoReview: true, reviewMaxRounds: 1 });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.reviews.submit(task.id, { findings: [{ severity: "blocking", title: "x" }] }, "reviewer");
    expect(s.tasks.summary(task.id).review?.state).toBe("stuck");
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("counts a clean PR review as the re-review of fixes made in the last local round", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.settings.update({ autoReview: true, reviewMaxRounds: 1 });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
    expect(s.tasks.summary(task.id).review).toMatchObject({ state: "fixed", round: 1, verifiedOnPr: false });
    // Timestamps have millisecond resolution: the review has to finish after the fix.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pass();
    expect(requests).toHaveLength(1);
    expect(s.tasks.summary(task.id).review).toMatchObject({ state: "clean", verifiedOnPr: true });
  });

  it("doesn't count a PR review that asked for fixes as the re-review", async () => {
    const { s, task, setPr, pass, turnOn, setIssues, requests } = setup();
    s.settings.update({ autoReview: true, reviewMaxRounds: 1 });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
    setIssues([issue("major")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pass();
    expect(requests).toHaveLength(1);
    expect(s.tasks.summary(task.id).review).toMatchObject({ state: "fixed", verifiedOnPr: false });
  });

  it("doesn't hold a PR for fixes nobody will re-review because auto-review is off for the task", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    // A one-off round on request: the major is fixed, and the board won't open round 2 with auto-review off.
    s.reviews.openRound(task.id, { trigger: "manual", actor: "user" });
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
    expect(s.tasks.summary(task.id).review?.state).toBe("fixed");
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("isn't held back by a task without local review", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    expect(s.tasks.summary(task.id).review).toBeNull();
    await pass();
    expect(requests).toHaveLength(1);
  });

  it.each(["backlog", "planned"] as const)("holds a PR on a %s task while auto-review is on", async (status) => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.settings.update({ autoReview: true });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status }, "agent");
    await pass();
    expect(requests).toHaveLength(0);
  });

  it("holds a PR linked before the task reached Review while auto-review is on, then reviews it after a clean loop", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.settings.update({ autoReview: true });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    await pass();
    expect(requests).toHaveLength(0);
    s.tasks.move(task.id, { status: "review" }, "agent");
    await pass();
    expect(requests).toHaveLength(0);
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("reviews a PR on an in-progress task when auto-review is off for it", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.tasks.update(task.id, { autoReview: false }, "agent");
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("waits for the next loop when a task goes back to In Progress after its loop", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    s.settings.update({ autoReview: true });
    turnOn();
    setPr();
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    expect(s.tasks.summary(task.id).review?.state).toBe("pending");
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
    expect(requests[1]!.label).toBe("Review PRs · PR #7 round 2");
  });

  it("waits for a review that is still running, and skips it (no failure, no round) if the head moved meanwhile", async () => {
    const { requests, posts, setPr, pass, turnOn, holdRunner, runs, engine } = setup();
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
    // Round 1 read the old head: GitHub's is the new one, so nothing was posted and nothing failed.
    expect(posts).toHaveLength(1);
    expect(runs().find((r) => r.dedupeKey.endsWith(SHA_A))).toMatchObject({
      status: "skipped",
      summary: "PR #7 moved on while it was being reviewed",
      needsAttention: false,
    });
    // The latest head is reviewed next, and it is still the first round.
    await pass();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("review round 1 of 3");
    expect(requests[1]!.prompt).toContain(`head commit ${SHA_B}`);
    expect(runs().filter((r) => r.status === "succeeded")).toHaveLength(1);
  });

  it("reviews the next head with the earlier review in view when the first one finished", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    setPr({ headOid: SHA_B });
    await pass();
    expect(requests[1]!.prompt).toContain("review round 2 of 3");
    expect(requests[1]!.prompt).toContain("Earlier reviews");
  });

  it("skips, without a failure or a round, when the branch moved past the commit before the agent started", async () => {
    const { setPr, pass, turnOn, failRunner, runs, posts, requests } = setup();
    turnOn();
    failRunner(new WorktreeHeadError("The branch moved on", SHA_B, true));
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: false });
    expect(posts).toEqual([]);
    failRunner(null);
    setPr({ headOid: SHA_B });
    await pass();
    expect(requests[1]!.prompt).toContain("review round 1 of 3");
  });

  it("fails the run, flagged, when the worktree is at a commit that was never the PR's", async () => {
    const { setPr, pass, turnOn, failRunner, runs, posts } = setup();
    turnOn();
    // GitHub still says a1b2c3d is the head, so it is the checkout that's wrong.
    failRunner(new WorktreeHeadError("The worktree is at 9999999, not the PR's head a1b2c3d", "9999999", false));
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    expect(runs()[0]!.error).toContain("not the PR's head");
    expect(posts).toEqual([]);
  });

  it("skips, not fails, when the branch was rewritten: the worktree isn't past the commit, but GitHub's head isn't it either", async () => {
    const { setPr, pass, turnOn, failRunner, setLive, runs, requests } = setup();
    turnOn();
    failRunner(new WorktreeHeadError("The worktree is at ffffff0, not the PR's head a1b2c3d", "ffffff0", false));
    // The poll hasn't caught up yet, but GitHub already has the force-pushed head.
    setLive(SHA_C);
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({
      status: "skipped",
      summary: "PR #7 moved on while it was being reviewed",
      needsAttention: false,
    });
    // And it is no round used: the new head is the first.
    failRunner(null);
    setLive(null);
    setPr({ headOid: SHA_C });
    await pass();
    expect(requests.at(-1)!.prompt).toContain("review round 1 of 3");
  });

  it("stops after the rounds set for a PR", async () => {
    const { requests, setPr, pass, turnOn, prSettings } = setup();
    prSettings({ rounds: 2 });
    turnOn();
    for (const sha of [SHA_A, SHA_B, SHA_C]) {
      setPr({ headOid: sha });
      await pass();
    }
    expect(requests).toHaveLength(2);
  });

  it("says so under Needs attention when the PR changes after its last round, instead of skipping it silently", async () => {
    const { s, task, requests, setPr, pass, turnOn, prSettings, runs } = setup();
    prSettings({ rounds: 2 });
    turnOn();
    for (const sha of [SHA_A, SHA_B, SHA_C]) {
      setPr({ headOid: sha, baseRef: "main" });
      await pass();
    }
    expect(requests).toHaveLength(2);
    const stopped = runs()[0]!;
    expect(stopped).toMatchObject({ status: "skipped", needsAttention: true });
    expect(stopped.summary).toContain("PR #7 changed after Review PRs' last round (round 2, at b2c3d4e)");
    expect(stopped.summary).toContain("retry this run to allow one more round");
    expect(s.tasks.summary(task.id).attention).toContainEqual(
      expect.objectContaining({
        kind: "autopilot",
        message: expect.stringContaining("changed after Review PRs' last round"),
      }),
    );
    // Nothing more at that head until the user says so.
    await pass();
    expect(runs()).toHaveLength(3);
  });

  it("counts a failed review as a round used", async () => {
    const { setPr, pass, turnOn, requests, failPost, prSettings, runs } = setup();
    prSettings({ rounds: 2 });
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
    const { requests, setPr, pass, turnOn, s, task, engineSettings } = setup();
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
      untrustedInput: true,
      expectHead: SHA_A,
    });
    expect(request!.outputSchema).toMatchObject({ required: ["summary", "issues"] });
    // The board's agent defaults: Auto, which for a review is headless.
    expect(request!.options).toMatchObject({ runner: "auto", budgetUsd: 5, timeoutMinutes: 60 });
  });

  it("reads this PR through the board's run tools, and has no gh rules to write to GitHub with", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    const [request] = requests;
    expect(request!.runTools).toEqual({
      toolSet: "prReview",
      target: { kind: "pr", host: "github.com", repo: "acme/app", number: 7 },
    });
    expect(request!.tools ?? []).toEqual([]);
    const prompt = request!.prompt;
    for (const tool of ["pr_overview", "pr_files", "pr_diff", "pr_comments"]) expect(prompt).toContain(`\`${tool}\``);
    expect(prompt).toContain(`\`${RUN_SERVER_NAME}\``);
    expect(prompt).toContain("never cut off, only paged");
    expect(prompt).not.toMatch(/\bgh (pr|api)\b/);
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
    expect(prompt).not.toContain("git rev-parse");
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
    answerWith(() => ({ summary: "no issues list" }));
    turnOn();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    expect(runs()[0]!.error).toContain("wasn't a review");
    expect(posts).toEqual([]);
    expect(notes()).toEqual([]);
  });

  it("fails the run, flagged, when GitHub refuses the review, keeping what the agent cost", async () => {
    const { setPr, pass, turnOn, failPost, runs, notes } = setup();
    failPost("Could not resolve to a PullRequest");
    turnOn();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true, costUsd: 0.5 });
    expect(runs()[0]!.error).toContain("Could not resolve");
    expect(notes()).toEqual([]);
  });

  it("tries the post again, without a failure or a round used, when GitHub fails in passing", async () => {
    const { setPr, pass, turnOn, failPost, runs, requests, notes } = setup();
    turnOn();
    failPost("GitHub couldn't post the review: An internal error occurred, please try again.");
    setPr();
    await pass();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: false, output: { retry: true } });
    expect(runs()[0]!.summary).toContain(`try 1 of ${REVIEW_ATTEMPTS}, will retry)`);
    expect(runs()[0]!.summary).toContain("GitHub couldn't post the review");
    expect(notes()).toEqual([]);
    failPost(null);
    await pass();
    // The same head, reviewed again as the first round, and now it posted.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("review round 1 of 3");
    const [first, second] = runs().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(first!.dedupeKey).toMatch(new RegExp(`^review:pr:.+:${SHA_A}$`));
    expect(second!.dedupeKey).toBe(`${first!.dedupeKey}:2`);
    expect(second).toMatchObject({ status: "succeeded" });
    expect(notes()).toHaveLength(1);
    // Settled: nothing more at this head.
    await pass();
    expect(requests).toHaveLength(2);
  });

  it("fails the run, flagged, once GitHub has failed in passing on every try", async () => {
    const { setPr, pass, turnOn, failPost, runs, requests } = setup();
    turnOn();
    failPost("GitHub couldn't post the review: GitHub at github.com returned HTTP 502");
    setPr();
    for (let i = 0; i < REVIEW_ATTEMPTS + 1; i += 1) await pass();
    expect(requests).toHaveLength(REVIEW_ATTEMPTS);
    const byTime = runs().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(byTime.map((r) => r.status)).toEqual(["skipped", "skipped", "failed"]);
    expect(byTime[2]).toMatchObject({ needsAttention: true });
    expect(byTime[2]!.error).toContain("GitHub couldn't post the review");
    expect(byTime[2]!.error).toContain(`after ${REVIEW_ATTEMPTS} tries`);
  });

  it("doesn't retry what the agent failed on, nor a refusal from GitHub", async () => {
    const { setPr, pass, turnOn, failRunner, failPost, runs, requests } = setup();
    turnOn();
    // The agent's own failure, even one that reads like a transient one, is a failure.
    failRunner(new Error("API Error: 502 try again"));
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    failRunner(null);
    failPost("Line must be part of the diff");
    setPr({ headOid: SHA_B });
    await pass();
    expect(runs().filter((r) => r.status === "failed")).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it("skips when the PR moved on before the agent started", async () => {
    const { s, setPr, turnOn, runs } = setup();
    turnOn();
    setPr();
    const [candidate] = await reviewPrs.check({
      services: s,
      engine: s.autopilot.engine(),
      now: new Date(),
      projects: s.projects.list().map((project) => ({ project, config: reviewPrs.defaults, dryRun: false })),
      board: null,
    });
    expect(candidate).toBeDefined();
    // The head changes between the check and the action.
    setPr({ headOid: SHA_D });
    const result = await reviewPrs.act(candidate!, {
      services: s,
      runner: { start: () => Promise.reject(new Error("must not run")) },
      gitHosts: {
        ...NO_GIT_HOSTS,
        postReview: () => Promise.reject(new Error("must not post")),
        prHead: () => Promise.reject(new Error("must not read")),
      },
      runGit: () => Promise.reject(new Error("must not run git")),
      engine: s.autopilot.engine(),
      boardUrl: "http://127.0.0.1:5317",
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
    expect(post!.input.body).toContain(`📋 ${BRAND.name} Autopilot review`);
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

  it("honours a lower fix threshold set on Fix PRs", async () => {
    const { setPr, pass, turnOn, setIssues, runs, prSettings } = setup();
    prSettings({ fixThreshold: "minor" });
    setIssues([issue("minor")]);
    turnOn();
    setPr();
    await pass();
    expect(prReviewOutput(runs()[0]!)).toMatchObject({ handoff: "fix", threshold: "minor" });
  });

  it("raises the bar to major on the last round, and says so in the prompt", async () => {
    const { requests, setPr, pass, turnOn, setIssues, runs, prSettings } = setup();
    prSettings({ fixThreshold: "nit", rounds: 2 });
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
    const { s, task, setPr, pass, turnOn, setIssues, runs, prSettings } = setup();
    prSettings({ rounds: 2 });
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
    expect(prompt).toContain("put its comment `id` (the number `pr_comments` shows for an inline comment) in `fixed`");
  });

  it("resolves its own earlier threads a later round confirms fixed, and no one else's", async () => {
    const { setPr, pass, turnOn, setIssues, answerWith, resolved, runs, setThreads } = setup();
    setIssues([issue("major")]);
    turnOn();
    setPr();
    await pass();
    // Review 101 was round 1's; 77 is a colleague's.
    const thread = (id: string, rootCommentId: number, rootReviewId: number): ReviewThreadDetail => ({
      id,
      canResolve: true,
      lastCommentId: rootCommentId,
      ownLast: false,
      lastReviewId: rootReviewId,
      rootCommentId,
      rootReviewId,
      reply: null,
      fixedIn: null,
    });
    setThreads([thread("OWN", 11, 101), thread("OTHER", 12, 77), thread("STILL", 13, 101)]);
    setPr({ headOid: SHA_B });
    answerWith(() => ({ summary: "Fixed.", issues: [], fixed: [11, 12] }));
    await pass();
    expect(resolved).toEqual(["OWN"]);
    expect(runs()[0]!.summary).toContain("resolved 1 earlier thread it confirmed fixed");
    expect(runs()[0]!.output).toMatchObject({ resolvedThreads: 1, handoff: "clean" });
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

describe("review PRs: a head that moved by merging the base in", () => {
  /** Rounds used: the runs that count, by the dedupe keys of their heads. */
  const reviewOf = (run: Parameters<typeof prReviewOutput>[0]) => prReviewOutput(run);

  it("carries a clean last round forward across a base merge git made on its own: no agent, no round", async () => {
    const { requests, posts, setPr, pass, turnOn, prSettings, runs, notes, moveHead, linkId, s } = setup();
    prSettings({ rounds: 1 });
    turnOn();
    setPr({ baseRef: "epic/1-thing" });
    await pass();
    expect(requests).toHaveLength(1);
    // The epic's branch moved on, and its merge into the PR went in without a conflict.
    moveHead(SHA_A, SHA_B, "clean");
    setPr({ headOid: SHA_B, baseRef: "epic/1-thing" });
    await pass();
    expect(requests).toHaveLength(1);
    expect(posts).toHaveLength(1);
    const carried = runs()[0]!;
    expect(carried).toMatchObject({ status: "succeeded", needsAttention: false });
    expect(reviewOf(carried)).toMatchObject({
      headOid: SHA_B,
      basis: "carried",
      carriedFrom: SHA_A,
      round: 1,
      handoff: "clean",
      actionable: 0,
    });
    expect(carried.summary).toContain("Carried the review of PR #7 from a1b2c3d to b2c3d4e");
    expect(notes().at(-1)).toContain("No review round used");
    // What the merge gate and Fix PRs read: a verdict at the PR's head.
    expect(currentPrReview(s.autopilot.runsForTask(runs()[0]!.taskId!), linkId(), SHA_B)?.basis).toBe("carried");
    // And again: a second base merge carries the carried verdict on.
    moveHead(SHA_B, SHA_C, "clean");
    setPr({ headOid: SHA_C, baseRef: "epic/1-thing" });
    await pass();
    expect(requests).toHaveLength(1);
    expect(reviewOf(runs()[0]!)).toMatchObject({ headOid: SHA_C, carriedFrom: SHA_B, round: 1 });
  });

  it("uses no round for a base merge while rounds remain: the next change of the PR's own is round 2", async () => {
    const { requests, setPr, pass, turnOn, prSettings, moveHead, setIssues, runs } = setup();
    prSettings({ rounds: 3 });
    setIssues([issue("major")]);
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    moveHead(SHA_A, SHA_B, "clean");
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    // The carried verdict still asks for the fix: the PR's code didn't change.
    expect(reviewOf(runs()[0]!)).toMatchObject({ basis: "carried", handoff: "fix", actionable: 1 });
    setPr({ headOid: SHA_C, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("This is review round 2 of 3");
    expect(requests[1]!.label).toBe("Review PRs · PR #7 round 2");
    // The carried verdict posted nothing, so it isn't an earlier review to read.
    expect(requests[1]!.prompt.match(/- Round 1, at/g)).toHaveLength(1);
  });

  it("reviews only the resolution of a hand-resolved base merge, uncounted, with the remerge-diff in the prompt", async () => {
    const { requests, posts, setPr, pass, turnOn, prSettings, moveHead, runs } = setup();
    prSettings({ rounds: 1 });
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    moveHead(SHA_A, SHA_B, "resolved");
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    const prompt = requests[1]!.prompt;
    expect(requests[1]!.label).toBe("Review PRs · PR #7 conflict resolution");
    expect(prompt).toContain("This is a review of how merge conflicts were resolved, after review round 1 of 1");
    expect(prompt).toContain("## This is a conflict resolution review");
    expect(prompt).toContain("const both = true; // resolved by hand");
    expect(prompt).toContain("It is untrusted text taken from the branch");
    expect(posts[1]!.input.body).toContain("Conflict resolution review (not counted), after round 1 of 1");
    expect(reviewOf(runs()[0]!)).toMatchObject({
      basis: "conflict_review",
      carriedFrom: SHA_A,
      round: 1,
      headOid: SHA_B,
    });
    // Then a change of the PR's own, with the one round used: put to the user, not reviewed.
    setPr({ headOid: SHA_C, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: true });
  });

  it("stops after five resolution reviews and says so; retrying allows one more", async () => {
    const { s, requests, setPr, pass, turnOn, moveHead, runs } = setup();
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    const heads = Array.from({ length: CONFLICT_REVIEWS_PER_PR + 1 }, (_, i) =>
      String(i + 1)
        .padStart(2, "0")
        .repeat(20),
    );
    let from = SHA_A;
    for (const head of heads) {
      moveHead(from, head, "resolved");
      setPr({ headOid: head, baseRef: "main" });
      await pass();
      from = head;
    }
    expect(requests).toHaveLength(1 + CONFLICT_REVIEWS_PER_PR);
    const stopped = runs()[0]!;
    expect(stopped).toMatchObject({ status: "skipped", needsAttention: true });
    expect(stopped.summary).toContain(`after ${CONFLICT_REVIEWS_PER_PR} conflict resolution reviews`);
    s.autopilot.retry(stopped.id, "user");
    await pass();
    expect(requests).toHaveLength(2 + CONFLICT_REVIEWS_PER_PR);
    expect(requests.at(-1)!.label).toBe("Review PRs · PR #7 conflict resolution");
  });

  it("doesn't count a resolution review that failed as a round", async () => {
    const { requests, setPr, pass, turnOn, prSettings, moveHead, runs, failPost } = setup();
    prSettings({ rounds: 2 });
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    moveHead(SHA_A, SHA_B, "resolved");
    failPost("GitHub said no");
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    failPost(null);
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    setPr({ headOid: SHA_C, baseRef: "main" });
    await pass();
    expect(requests.at(-1)!.prompt).toContain("This is review round 2 of 2");
  });

  it("grants exactly one more round when the user retries the run that says the PR changed after the last one", async () => {
    const { s, requests, setPr, pass, turnOn, prSettings, runs } = setup();
    prSettings({ rounds: 1 });
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    const stopped = runs()[0]!;
    expect(stopped.summary).toContain("PR #7 changed after Review PRs' last round (round 1, at a1b2c3d)");
    expect(stopped.summary).toContain("the branch was rewritten");
    s.autopilot.retry(stopped.id, "user");
    await pass();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("This is review round 2 of 2");
    // That round was the one granted: the next change is put to the user again.
    setPr({ headOid: SHA_C, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: true });
    expect(runs()[0]!.summary).toContain("(round 2, at b2c3d4e)");
  });

  it("grants a round only for a notice of the PR's current head, so a stale one banks nothing", async () => {
    const { s, requests, setPr, pass, turnOn, prSettings, runs } = setup();
    prSettings({ rounds: 1 });
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    const stale = runs()[0]!;
    setPr({ headOid: SHA_C, baseRef: "main" });
    await pass();
    const current = runs()[0]!;
    expect(current).toMatchObject({ status: "skipped", needsAttention: true });
    // The older head's notice is history: the board won't retry it, so it can't bank a round for later.
    expect(() => s.autopilot.retry(stale.id, "user")).toThrow("run again since");
    await pass();
    expect(requests).toHaveLength(1);
    s.autopilot.retry(current.id, "user");
    await pass();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("This is review round 2 of 2");
    // One round granted, one used: the next change is put to the user again.
    setPr({ headOid: SHA_D, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: true });
  });

  it("keeps what the review before it left open when a resolution review finds the merge clean", async () => {
    const { s, task, requests, posts, setPr, pass, turnOn, prSettings, moveHead, runs, linkId, setIssues } = setup();
    prSettings({ rounds: 2 });
    setIssues([issue("major"), issue("major", { title: "Another" })]);
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    expect(reviewOf(runs()[0]!)).toMatchObject({ handoff: "fix", actionable: 2 });
    // The conflicts of a base merge were resolved by hand, and the resolution itself is fine.
    setIssues([]);
    moveHead(SHA_A, SHA_B, "resolved");
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    const verdict = currentPrReview(s.autopilot.runsForTask(task.id), linkId(), SHA_B)!;
    expect(verdict).toMatchObject({ basis: "conflict_review", actionable: 2, handoff: "fix" });
    expect(verdict.counts.major).toBe(2);
    expect(verdict.openFrom).toEqual({
      reviewId: 101,
      reviewUrl: "https://github.com/acme/app/pull/7#pullrequestreview-101",
    });
    expect(runs()[0]!.summary).toContain("and 2 still open from round 1");
    expect(posts[1]!.input.body).toContain(
      "Round 1's review (https://github.com/acme/app/pull/7#pullrequestreview-101) left 2 points at or above major open",
    );
  });

  it("counts a granted round in a later resolution review's 'round N of M'", async () => {
    const { s, requests, posts, setPr, pass, turnOn, prSettings, moveHead, runs } = setup();
    prSettings({ rounds: 1 });
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    s.autopilot.retry(runs()[0]!.id, "user");
    await pass();
    expect(requests).toHaveLength(2);
    moveHead(SHA_B, SHA_C, "resolved");
    setPr({ headOid: SHA_C, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(3);
    expect(requests[2]!.prompt).toContain("after review round 2 of 2");
    expect(posts.at(-1)!.input.body).toContain("after round 2 of 2");
    expect(reviewOf(runs()[0]!)).toMatchObject({ round: 2, maxRounds: 2 });
  });

  it("still gives up after a resolution review on the last round when earlier points are open", async () => {
    const { requests, setPr, pass, turnOn, prSettings, moveHead, runs, setIssues } = setup();
    prSettings({ rounds: 1 });
    setIssues([issue("major")]);
    turnOn();
    setPr({ baseRef: "main" });
    await pass();
    expect(reviewOf(runs()[0]!)).toMatchObject({ handoff: "gave_up", actionable: 1 });
    setIssues([]);
    moveHead(SHA_A, SHA_B, "resolved");
    setPr({ headOid: SHA_B, baseRef: "main" });
    await pass();
    expect(requests).toHaveLength(2);
    expect(reviewOf(runs()[0]!)).toMatchObject({ basis: "conflict_review", handoff: "gave_up", actionable: 1 });
    expect(runs()[0]).toMatchObject({ needsAttention: true });
  });

  it("treats a move git can't read as a change of the PR's own, so it is never let through unreviewed", async () => {
    const { requests, setPr, pass, turnOn, prSettings, runs } = setup();
    prSettings({ rounds: 3 });
    turnOn();
    // No base branch read yet: nothing to classify against.
    setPr();
    await pass();
    setPr({ headOid: SHA_B });
    await pass();
    expect(requests).toHaveLength(2);
    expect(reviewOf(runs()[0]!)).toMatchObject({ round: 2 });
    expect(reviewOf(runs()[0]!)?.basis).toBeUndefined();
  });
});
