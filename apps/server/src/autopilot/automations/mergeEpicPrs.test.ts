import {
  AUTOPILOT_MERGE_EPIC_PRS,
  AUTOPILOT_REVIEW_PRS,
  prReviewDedupeKey,
  type PrReviewRunOutput,
  type PrSnapshot,
} from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAutopilotMergeTarget,
  MergeTargetError,
  type EpicMergeInput,
  type EpicPrInput,
} from "../../integrations/github.ts";
import { AppError } from "../../errors.ts";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { NO_GITHUB, NO_RUNNER, type GithubActions } from "../types.ts";
import { epicPrBody, MERGE_ATTEMPTS, mergeEpicPrs, NO_CHECKS_WAIT_MS } from "./mergeEpicPrs.ts";
import { reviewPrs } from "./reviewPrs.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it", status: "done" as const }] }] };
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
const BRANCH = "epic/1-checkout";

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Add the thing",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/thing",
  baseRef: BRANCH,
  updatedAt: null,
  headOid: SHA_A,
  ...over,
});

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

function setup() {
  const merges: Array<{ linkId: string; input: EpicMergeInput }> = [];
  const opened: EpicPrInput[] = [];
  const bodies: Array<{ number: number; body: string }> = [];
  let mergeError: Error | null = null;
  let openError: Error | null = null;
  const h = createTestHarness({ integrations: { automations: [reviewPrs, mergeEpicPrs] } });
  const s = h.services;
  const github: GithubActions = {
    ...NO_GITHUB,
    mergeIntoEpicBranch: async (link, input) => {
      merges.push({ linkId: link.id, input });
      if (mergeError) throw mergeError;
      // As the real one: the refreshed snapshot says merged, which moves the task to Done.
      s.links.setSnapshot(link.id, snapshot({ state: "merged", headOid: input.headOid }));
    },
    ensureEpicPr: async (input) => {
      opened.push(input);
      if (openError) throw openError;
      return { number: 90, url: "https://github.com/acme/app/pull/90", created: true };
    },
    setPrBody: async (ref, body) => {
      bodies.push({ number: ref.number, body });
    },
  };
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: NO_RUNNER,
    github,
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const epic = s.tasks.createEpic({ projectId: project.id, title: "Checkout" }, [], "user");
  s.tasks.setDelivery(epic.id, "integration", BRANCH, "user");
  const task = s.tasks.create({
    projectId: project.id,
    title: "Add the thing",
    plan,
    epicId: epic.id,
    links: [{ value: "https://github.com/acme/app/pull/7" }],
  });
  s.tasks.update(task.id, { autoReview: false }, "user");
  const linkId = () => s.tasks.summary(task.id).links.find((l) => l.kind === "pr")!.id;
  const setPr = (over: Partial<PrSnapshot> = {}) => s.links.setSnapshot(linkId(), snapshot(over));
  const toReview = () => s.tasks.move(task.id, { status: "review" }, "agent");
  const pass = async () => {
    await engine.pass();
    await engine.idle();
  };
  const turnOn = (automation = AUTOPILOT_MERGE_EPIC_PRS) =>
    s.autopilot.setScope("project", project.id, automation, { mode: "on" });
  const runs = (taskId = task.id) =>
    s.autopilot.runsForTask(taskId).filter((r) => r.automation === AUTOPILOT_MERGE_EPIC_PRS);
  const reviewed = (over: Partial<PrReviewRunOutput> = {}) => {
    const output: PrReviewRunOutput = {
      kind: "pr_review",
      linkId: linkId(),
      prUrl: "https://github.com/acme/app/pull/7",
      headOid: SHA_A,
      round: 1,
      maxRounds: 3,
      reviewUrl: "https://github.com/acme/app/pull/7#pullrequestreview-900",
      reviewId: 900,
      counts: { blocking: 0, major: 0, minor: 1, nit: 0 },
      fyi: 0,
      threshold: "major",
      actionable: 0,
      handoff: "clean",
      ...over,
    };
    const run = s.autopilot.record({
      automation: AUTOPILOT_REVIEW_PRS,
      candidate: {
        dedupeKey: `${prReviewDedupeKey(output.linkId, output.headOid)}:${output.round}`,
        summary: "review",
        taskId: task.id,
      },
      dryRun: false,
    })!;
    s.autopilot.start(run.id);
    s.autopilot.finish(run.id, { output: { ...output } });
  };
  return {
    ...h,
    s,
    project,
    epic,
    task,
    linkId,
    setPr,
    toReview,
    pass,
    turnOn,
    runs,
    reviewed,
    merges,
    opened,
    bodies,
    failMerge: (e: Error | null) => (mergeError = e),
    failOpen: (e: Error | null) => (openError = e),
  };
}

describe("merge into epic branch", () => {
  it("merges a reviewed, green PR into the epic's branch with a merge commit, once per head, and the task goes Done", async () => {
    const { s, task, setPr, toReview, pass, turnOn, runs, merges, linkId } = setup();
    turnOn();
    toReview();
    setPr();
    await pass();
    expect(merges).toEqual([{ linkId: linkId(), input: { base: BRANCH, headOid: SHA_A } }]);
    expect(runs()[0]).toMatchObject({ status: "succeeded", dedupeKey: `merge:${linkId()}:${SHA_A}` });
    expect(s.tasks.summary(task.id).status).toBe("done");
    await pass();
    expect(merges).toHaveLength(1);
  });

  it("waits for Review, an open PR into the branch, passing checks and a clean merge", async () => {
    const { setPr, toReview, pass, turnOn, merges } = setup();
    turnOn();
    setPr();
    await pass();
    expect(merges).toHaveLength(0); // still Planned
    toReview();
    for (const over of [
      { state: "draft" as const },
      { baseRef: "main" },
      { checks: "pending" as const },
      { checks: "failing" as const },
      { mergeable: "conflicting" as const },
      { mergeable: "unknown" as const },
    ]) {
      setPr(over);
      await pass();
      expect(merges).toHaveLength(0);
    }
    setPr({ reviewDecision: "changes_requested" });
    await pass();
    expect(merges).toHaveLength(0);
    // No checks reported yet: GitHub says none for a moment after a push, so it waits that out.
    vi.useFakeTimers({ toFake: ["Date"] });
    setPr({ checks: "none" });
    await pass();
    expect(merges).toHaveLength(0);
    vi.setSystemTime(Date.now() + NO_CHECKS_WAIT_MS);
    await pass();
    expect(merges).toHaveLength(1);
  });

  it("waits for the local review loop and for its blocking or major findings", async () => {
    const { s, task, setPr, toReview, pass, turnOn, merges } = setup();
    turnOn();
    s.tasks.update(task.id, { autoReview: true }, "user");
    toReview();
    setPr();
    await pass();
    expect(merges).toHaveLength(0); // round 1 pending
    const round = s.reviews.list(task.id).at(-1)!;
    s.reviews.submit(task.id, { round: round.round, findings: [{ severity: "major", title: "Wrong" }] }, "reviewer");
    await pass();
    expect(merges).toHaveLength(0);
  });

  it("with Review PRs on, merges only once its review of the current head is clean", async () => {
    const { setPr, toReview, pass, turnOn, merges, reviewed } = setup();
    turnOn();
    turnOn(AUTOPILOT_REVIEW_PRS);
    toReview();
    setPr();
    await pass();
    expect(merges).toHaveLength(0); // not reviewed yet (Review PRs itself has no runner here)
    reviewed({ headOid: SHA_B, round: 1 }); // an older head says nothing
    reviewed({ actionable: 2, counts: { blocking: 0, major: 2, minor: 0, nit: 0 }, handoff: "fix", round: 2 });
    await pass();
    expect(merges).toHaveLength(0);
    reviewed({ round: 3 });
    await pass();
    expect(merges).toHaveLength(1);
  });

  it("flags the task Ready to merge into the epic branch when GitHub refuses, and notifies", async () => {
    const { s, task, setPr, toReview, pass, turnOn, runs, failMerge } = setup();
    turnOn();
    failMerge(new AppError("VALIDATION", "At least 1 approving review is required"));
    toReview();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: true });
    const summary = s.tasks.summary(task.id);
    expect(summary.status).toBe("review");
    expect(summary.attention.find((a) => a.kind === "autopilot")?.message).toMatch(
      /^Ready to merge into the epic branch: .*approving review/,
    );
    expect(s.notifications.list().items.some((n) => n.kind === "autopilot_failed")).toBe(true);
  });

  it("tries a head again after a failure that may pass, then asks the user", async () => {
    const { s, task, setPr, toReview, pass, turnOn, runs, merges, failMerge } = setup();
    turnOn();
    failMerge(new AppError("VALIDATION", "Base branch was modified. Review and try the merge again."));
    toReview();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "skipped", needsAttention: false, output: { retry: true } });
    expect(s.tasks.summary(task.id).attention).toEqual([]);
    await pass();
    await pass();
    await pass();
    expect(merges).toHaveLength(MERGE_ATTEMPTS);
    expect(runs()[0]).toMatchObject({ needsAttention: true });
    expect(runs()[0]!.summary).toMatch(/^Ready to merge into the epic branch/);
    // A new head starts over.
    failMerge(null);
    setPr({ headOid: SHA_B });
    await pass();
    expect(merges.at(-1)!.input.headOid).toBe(SHA_B);
  });

  it("never merges a task of an epic delivered to main", async () => {
    const { s, epic, setPr, toReview, pass, turnOn, merges } = setup();
    s.tasks.setDelivery(epic.id, "main", null, "user");
    turnOn();
    toReview();
    setPr({ baseRef: "main" });
    await pass();
    expect(merges).toHaveLength(0);
  });

  it("opens the epic's draft PR after the first merge, links it, and keeps its description current", async () => {
    const { s, epic, setPr, toReview, pass, turnOn, opened, bodies } = setup();
    turnOn();
    toReview();
    setPr();
    await pass(); // merges
    await pass(); // opens the epic PR
    expect(opened).toEqual([
      expect.objectContaining({ host: "github.com", repo: "acme/app", head: BRANCH, title: "Epic #1: Checkout" }),
    ]);
    expect(opened[0]!.body).toContain("- [x] #2 Add the thing");
    const epicPr = () => s.tasks.summary(epic.id).links.find((l) => l.kind === "pr")!;
    expect(epicPr().url).toBe("https://github.com/acme/app/pull/90");
    // Not polled yet: nothing to update.
    await pass();
    expect(bodies).toHaveLength(0);
    s.links.setSnapshot(epicPr().id, snapshot({ state: "draft", headRef: BRANCH, baseRef: "main" }));
    s.tasks.create({ projectId: s.tasks.summary(epic.id).projectId, title: "Next", epicId: epic.id });
    await pass();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.body).toContain("#3 Next");
    await pass();
    expect(bodies).toHaveLength(1); // same body, same key
  });
});

describe("the epic's PR when opening it fails", () => {
  it("tries again after the next merge", async () => {
    const { s, project, epic, setPr, toReview, pass, turnOn, opened, failOpen } = setup();
    turnOn();
    failOpen(new AppError("VALIDATION", "GitHub is unavailable"));
    toReview();
    setPr();
    await pass(); // merges
    await pass(); // tries to open the epic PR, and fails
    expect(opened).toHaveLength(1);
    await pass();
    expect(opened).toHaveLength(1);
    failOpen(null);
    const next = s.tasks.create({
      projectId: project.id,
      title: "Next",
      plan,
      epicId: epic.id,
      links: [{ value: "https://github.com/acme/app/pull/8" }],
    });
    s.tasks.update(next.id, { autoReview: false }, "user");
    s.tasks.move(next.id, { status: "review" }, "agent");
    const link = s.tasks.summary(next.id).links.find((l) => l.kind === "pr")!;
    s.links.setSnapshot(link.id, snapshot({ headOid: SHA_B }));
    await pass(); // merges the second
    await pass(); // opens the epic PR
    expect(opened).toHaveLength(2);
    expect(s.tasks.summary(epic.id).links.some((l) => l.kind === "pr")).toBe(true);
  });
});

describe("the default-branch guard", () => {
  it("refuses the default branch, a branch that isn't an epic's, and a retargeted PR", () => {
    const ok = { base: BRANCH, expectedBase: BRANCH, defaultBranch: "main" };
    expect(() => checkAutopilotMergeTarget(ok)).not.toThrow();
    expect(() => checkAutopilotMergeTarget({ ...ok, base: "main" })).toThrow(MergeTargetError);
    expect(() => checkAutopilotMergeTarget({ base: "main", expectedBase: "main", defaultBranch: "main" })).toThrow(
      /never merges into the default branch/,
    );
    expect(() => checkAutopilotMergeTarget({ ...ok, base: "release", expectedBase: "release" })).toThrow(
      /only merges into an epic's integration branch/,
    );
    expect(() => checkAutopilotMergeTarget({ ...ok, base: "epic/2-other" })).toThrow(/now merges into/);
    expect(() => checkAutopilotMergeTarget({ ...ok, defaultBranch: null })).toThrow(/default branch/);
  });

  it("fails the run, flagged, when GitHub's guard refuses", async () => {
    const { setPr, toReview, pass, turnOn, runs, failMerge } = setup();
    turnOn();
    failMerge(new MergeTargetError("Autopilot never merges into the default branch (main)"));
    toReview();
    setPr();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed", needsAttention: true });
    expect(runs()[0]!.error).toMatch(/never merges into the default branch/);
  });
});

describe("epicPrBody", () => {
  it("lists each task with its state, PRs and reviews, and holds no times", () => {
    const { s, epic, task, setPr } = setup();
    setPr({ state: "merged" });
    const body = epicPrBody(s.tasks.summary(epic.id), [s.tasks.summary(task.id)], () => []);
    expect(body).toContain(`delivered through the integration branch \`${BRANCH}\``);
    expect(body).toContain("It never merges this pull request");
    expect(body).toContain("## Tasks (0 of 1 done)");
    expect(body).toMatch(
      /- \[ \] #2 Add the thing · Planned · \[PR #7\]\(https:\/\/github.com\/acme\/app\/pull\/7\) merged/,
    );
  });
});
