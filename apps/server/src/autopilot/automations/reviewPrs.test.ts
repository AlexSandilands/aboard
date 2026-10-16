import {
  AUTOPILOT_REVIEW_PRS,
  BRAND,
  prReviewHeader,
  prReviewOutput,
  type AutopilotEngineSettings,
  type PrReviewIssue,
  type PrSnapshot,
} from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { Runner, RunnerRequest } from "../types.ts";
import { REVIEW_TOOLS, earlierReviews, reviewHandoff, reviewPrs } from "./reviewPrs.ts";

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

const issue = (severity: PrReviewIssue["severity"], fyi = false): PrReviewIssue => ({
  severity,
  title: `A ${severity}`,
  file: "src/a.ts",
  line: 3,
  fyi,
});

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup() {
  const requests: RunnerRequest[] = [];
  let issues: PrReviewIssue[] = [];
  let answer: ((request: RunnerRequest) => unknown) | null = null;
  let reviewId = 100;
  const runner: Runner = {
    start: async (request, update = () => {}) => {
      requests.push(request);
      update({ runner: "headless", costUsd: 0.5 });
      reviewId += 1;
      const output = answer
        ? answer(request)
        : {
            reviewUrl: `https://github.com/acme/app/pull/7#pullrequestreview-${reviewId}`,
            reviewId,
            headSha: /at head commit (\w{7})/.exec(request.prompt)?.[1] ?? "unknown",
            summary: "Looks reasonable.",
            issues,
          };
      return { runner: "headless", result: null, output };
    },
  };
  const h = createTestHarness({ integrations: { automations: [reviewPrs] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
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
  const engineSettings = (patch: Partial<AutopilotEngineSettings>) => s.autopilot.updateEngine(patch);
  const runs = () => s.autopilot.runsForTask(task.id).filter((r) => r.automation === AUTOPILOT_REVIEW_PRS);
  const notes = () =>
    s.tasks
      .detail(task.id)
      .events.filter((e) => e.type === "note")
      .map((e) => (e.payload as { text: string }).text);
  return {
    ...h,
    s,
    project,
    task,
    requests,
    setIssues: (next: PrReviewIssue[]) => (issues = next),
    answerWith: (fn: (request: RunnerRequest) => unknown) => (answer = fn),
    setPr,
    pass,
    turnOn,
    engineSettings,
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

  it("skips tasks that are Done, archived or epics' loose ends, and PRs with no branch or commit", async () => {
    const { s, task, setPr, pass, turnOn, requests } = setup();
    turnOn();
    setPr({ headOid: null });
    await pass();
    setPr({ headRef: null });
    await pass();
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
    expect(runs().map((r) => r.dedupeKey)).toHaveLength(2);
    expect(requests[1]!.prompt).toContain("review round 2 of 3");
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
  it("runs read-only on the PR's branch with gh to post, and answers in the verdict's shape", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    const [request] = requests;
    expect(request).toMatchObject({
      access: "read-only",
      workspace: { branch: "feat/thing" },
      tools: REVIEW_TOOLS,
    });
    expect(request!.outputSchema).toMatchObject({ required: ["reviewUrl", "headSha", "summary", "issues"] });
    // Reviews are posted with gh as a comment, and never decide the PR.
    expect(REVIEW_TOOLS).toEqual(expect.arrayContaining(["Bash(gh pr review *)", "Bash(gh api *)"]));
    expect(request!.options).toMatchObject({ runner: "headless", budgetUsd: 2 });
  });

  it("asks for a comment review with the product's header and a marker on each inline comment", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    const prompt = requests[0]!.prompt;
    expect(prompt).toContain(prReviewHeader());
    expect(prompt).toContain(`🤖 ${BRAND.name} Autopilot`);
    expect(prompt).toContain('"event": "COMMENT"');
    expect(prompt).toContain(`"commit_id": "${SHA_A}"`);
    expect(prompt).toContain("gh api repos/acme/app/pulls/7/reviews --method POST --input -");
    expect(prompt).not.toContain('"event": "APPROVE"');
    expect(prompt).not.toContain('"event": "REQUEST_CHANGES"');
    expect(prompt).toContain("Never approve and never request changes");
    expect(prompt).toContain("round 1 of 3");
    expect(prompt).not.toContain("Earlier reviews");
  });

  it("names the host for a GitHub Enterprise PR", async () => {
    const { s, task, pass, turnOn, requests } = setup();
    s.links.add(task.id, { value: "https://github.example.com/acme/app/pull/9" }, "user");
    const ghe = s.tasks.summary(task.id).links.find((l) => l.kind === "pr" && l.ref?.host === "github.example.com")!;
    s.links.setSnapshot(ghe.id, snapshot());
    turnOn();
    await pass();
    expect(requests[0]!.prompt).toContain("--hostname github.example.com");
  });

  it("follows the chosen skill", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn({ skill: { source: "global", name: "strict-review", path: "/nowhere/strict-review/SKILL.md" } });
    setPr();
    await pass();
    expect(requests[0]!.prompt).toContain('"strict-review" at /nowhere/strict-review/SKILL.md');
  });

  it("uses the built-in review skill by default", async () => {
    const { requests, setPr, pass, turnOn } = setup();
    turnOn();
    setPr();
    await pass();
    expect(requests[0]!.prompt).toContain("You are an independent reviewer.");
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
    expect(prReviewOutput(run!)).toMatchObject({
      kind: "pr_review",
      headOid: "a1b2c3d",
      reviewId: 101,
      handoff: "clean",
    });
  });

  it("fails the run, flagged, when the answer isn't a verdict", async () => {
    const { setPr, pass, turnOn, answerWith, runs, notes } = setup();
    answerWith(() => ({ summary: "no url" }));
    turnOn();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    expect(runs()[0]!.error).toContain("wasn't a review verdict");
    expect(notes()).toEqual([]);
  });

  it("skips when the PR moved on before the agent started", async () => {
    const { s, setPr, turnOn, runs, pass } = setup();
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
      engine: s.autopilot.engine(),
      config: reviewPrs.defaults,
      run: { id: "r" } as never,
      actor: "autopilot",
      update: () => {},
    });
    expect(result).toMatchObject({ status: "skipped", summary: "PR #7 moved on to d4e5f60" });
    expect(runs()).toEqual([]);
    await pass();
  });
});

describe("review PRs: verdict, threshold and hand-off", () => {
  it("counts non-FYI issues by severity and ignores FYI ones", async () => {
    const { setPr, pass, turnOn, setIssues, runs } = setup();
    setIssues([issue("major"), issue("minor"), issue("minor"), issue("nit", true), issue("blocking", true)]);
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
    setIssues([issue("major"), issue("nit", true)]);
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

  it("lists earlier reviews oldest first, from the link's finished runs only", () => {
    const base = { automation: AUTOPILOT_REVIEW_PRS, status: "succeeded" as const, dryRun: false };
    const output = (linkId: string, round: number) => ({
      kind: "pr_review",
      linkId,
      prUrl: "u",
      headOid: `sha${round}`,
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
});
