import { BOARD_REVIEWER, type T3ThreadSnapshot } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import type { HeadlessJob, HeadlessReview } from "./headlessReview.ts";
import { AGENT_REVIEW_GRACE_MS, createReviewFallbacks, REVIEW_GRACE_MS } from "./reviewFallbacks.ts";

// Rounds are stamped with the real clock a few ms after setup reads it, so step well past the grace period.
const PAST_GRACE = REVIEW_GRACE_MS + 60_000;
const PAST_AGENT_GRACE = AGENT_REVIEW_GRACE_MS + 60_000;

const snapshot = (status: T3ThreadSnapshot["status"]): T3ThreadSnapshot => ({ title: "Thread", status });

function setup(
  opts: { headless?: boolean; thread?: T3ThreadSnapshot["status"]; review?: () => Promise<HeadlessReview> } = {},
) {
  const h = createTestHarness();
  const s = h.services;
  s.settings.update({ autoReview: true, headlessReviewEnabled: opts.headless ?? false });
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = s.tasks.create({
    projectId: project.id,
    title: "Export",
    plan: { phases: [{ title: "a", steps: [{ title: "b" }] }] },
  });
  if (opts.thread) {
    const link = s.links.add(task.id, { t3Thread: { environmentId: "env", threadId: "th-1" } }, "agent");
    s.links.setSnapshot(link.id, snapshot(opts.thread));
  }
  let clock = Date.now();
  const sent: Array<{ text: string; commandId: string }> = [];
  const jobs: HeadlessJob[] = [];
  const t3 = {
    sendToThread: (_link: unknown, text: string, commandId: string) => {
      sent.push({ text, commandId });
      return Promise.resolve();
    },
    threadWorkspace: () =>
      Promise.resolve({
        worktreePath: "/wt/export",
        branch: "t3/export",
        runStatus: "running",
        latestRunId: "run-1",
        lastError: null,
        updatedAt: null,
      }),
  };
  const fallbacks = createReviewFallbacks({
    services: () => s,
    t3,
    now: () => clock,
    log: { warn: () => {} },
    runHeadless: (job) => {
      jobs.push(job);
      return opts.review ? opts.review() : Promise.resolve({ summary: "Clean", findings: [], costUsd: 0.1 });
    },
  });
  const advance = (ms: number) => (clock += ms);
  const round = () => s.reviews.list(task.id).at(-1);
  return { h, s, task, fallbacks, sent, jobs, advance, round };
}

describe("review fallbacks", () => {
  it("gives an agent's round a longer grace, from the task's last activity, then marks it stalled", async () => {
    const { s, task, fallbacks, advance, round } = setup();
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    s.tasks.move(task.id, { status: "review" }, "agent");
    advance(PAST_GRACE);
    await fallbacks.tick();
    expect(round()?.status).toBe("pending");
    advance(PAST_AGENT_GRACE);
    await fallbacks.tick();
    expect(round()).toMatchObject({ status: "stalled", error: "No agent ran the review" });
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("review_stalled");
  });

  it("leaves a round alone once its task turns manual: no nudge, no board review", async () => {
    const { s, task, fallbacks, advance, round, sent, jobs } = setup({ headless: true, thread: "done" });
    s.tasks.move(task.id, { status: "review" }, "user");
    s.tasks.update(task.id, { manual: true }, "user");
    await fallbacks.tick();
    advance(PAST_AGENT_GRACE);
    await fallbacks.tick();
    expect(sent).toEqual([]);
    expect(jobs).toEqual([]);
    expect(round()?.status).toBe("pending");
  });

  it("nudges the T3 thread at once when the user moved the card, then reviews headless if it stays quiet", async () => {
    const { s, task, fallbacks, advance, round, sent, jobs } = setup({
      headless: true,
      thread: "done",
      review: () =>
        Promise.resolve({ summary: "One bug", findings: [{ severity: "blocking", title: "Crash" }], costUsd: 0.25 }),
    });
    s.tasks.move(task.id, { status: "review" }, "user");
    await fallbacks.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Local review is on for this task: round 1 is open");
    expect(sent[0]!.commandId).toBe(`review-${round()!.id}-nudge`);
    expect(round()?.nudgedAt).not.toBeNull();

    await fallbacks.tick();
    expect(sent).toHaveLength(1);

    advance(PAST_GRACE);
    await fallbacks.tick();
    await fallbacks.idle();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ cwd: "/wt/export", budgetUsd: 2, cli: null, model: null });
    expect(jobs[0]!.prompt).toContain("#1 Export [Review]");
    expect(round()).toMatchObject({
      status: "submitted",
      reviewer: BOARD_REVIEWER,
      summary: "One bug (board review, $0.25)",
    });
    // Findings nobody is looping on go to the thread's agent.
    expect(sent.at(-1)?.text).toContain("found blocking or major issues");
    expect(sent.at(-1)?.commandId).toBe(`review-${round()!.id}-fix`);
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("review_unattended");
  });

  /** The board's headless review of a task finds only a nit; returns the "open the PR" messages sent. */
  const cleanBoardReview = async (linkPr: boolean) => {
    const { s, task, fallbacks, advance, round, sent } = setup({
      headless: true,
      thread: "done",
      review: () => Promise.resolve({ summary: "Fine", findings: [{ severity: "nit", title: "x" }], costUsd: null }),
    });
    if (linkPr) s.links.add(task.id, { value: "https://github.com/acme/app/pull/3" }, "agent");
    s.tasks.move(task.id, { status: "review" }, "user");
    await fallbacks.tick();
    advance(PAST_GRACE);
    await fallbacks.tick();
    await fallbacks.idle();
    expect(round()?.status).toBe("submitted");
    return sent.filter((m) => m.commandId.endsWith("-done"));
  };

  it("tells the thread to open the PR when the board's review comes back clean", async () => {
    const done = await cleanBoardReview(false);
    expect(done).toHaveLength(1);
    expect(done[0]!.text).toContain("came back clean");
    expect(done[0]!.text).toContain("open the pull request now");
  });

  it("doesn't, when the task already has a PR", async () => {
    expect(await cleanBoardReview(true)).toEqual([]);
  });

  it("runs the board's review on the chosen model: a typed one, or a tier's Claude Code model", async () => {
    const run = async (headlessReviewModel: Parameters<ReturnType<typeof setup>["s"]["settings"]["update"]>[0]) => {
      const { s, task, fallbacks, advance, jobs } = setup({ headless: true });
      s.settings.update({
        ...headlessReviewModel,
        modelTiers: { light: { description: null, t3: null, cli: { "claude-code": "haiku" } } },
      });
      s.tasks.move(task.id, { status: "review" }, "user");
      await fallbacks.tick();
      advance(PAST_GRACE);
      await fallbacks.tick();
      await fallbacks.idle();
      return jobs[0]?.model;
    };
    expect(await run({ headlessReviewModel: { model: "sonnet" } })).toBe("sonnet");
    expect(await run({ headlessReviewModel: { tier: "light" } })).toBe("haiku");
    expect(await run({ headlessReviewModel: { tier: "deep" } })).toBeNull();
  });

  it("keeps ticking after a pass with nothing to do", async () => {
    const { s, task, fallbacks, advance, round } = setup();
    await fallbacks.tick();
    await fallbacks.tick();
    s.tasks.move(task.id, { status: "review" }, "agent");
    advance(PAST_AGENT_GRACE);
    await fallbacks.tick();
    expect(round()?.status).toBe("stalled");
  });

  it("drops the board's review when an agent's reviewer submitted while it ran", async () => {
    const late = { submit: () => {} };
    const { s, task, fallbacks, round } = setup({
      headless: true,
      review: () => {
        late.submit();
        return Promise.resolve({ summary: "Board", findings: [{ severity: "blocking", title: "x" }], costUsd: null });
      },
    });
    late.submit = () => s.reviews.submit(task.id, { findings: [] }, "agent (reviewer)");
    s.tasks.move(task.id, { status: "review" }, "user");
    await fallbacks.tick();
    await fallbacks.idle();
    expect(round()).toMatchObject({ status: "submitted", reviewer: "agent (reviewer)", error: null });
    expect(s.tasks.summary(task.id).review?.state).toBe("clean");
  });

  it("treats a round the board opened after the fixes like an agent's: waits, nudges the thread, then reviews headless", async () => {
    const { s, task, fallbacks, advance, round, sent, jobs } = setup({ headless: true, thread: "done" });
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
    expect(round()).toMatchObject({ round: 2, status: "pending", openedBy: "board" });

    // Not a round the user asked for: the agent gets its grace before the thread is nudged.
    await fallbacks.tick();
    expect(sent).toEqual([]);
    advance(PAST_AGENT_GRACE);
    await fallbacks.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("round 2 is open");
    expect(sent[0]!.commandId).toBe(`review-${round()!.id}-nudge`);

    advance(PAST_GRACE);
    await fallbacks.tick();
    await fallbacks.idle();
    expect(jobs).toHaveLength(1);
    expect(round()).toMatchObject({ round: 2, status: "submitted", reviewer: BOARD_REVIEWER });
  });

  it("marks a round the board opened stalled when nothing can run it", async () => {
    const { s, task, fallbacks, advance, round } = setup();
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
    advance(PAST_AGENT_GRACE);
    await fallbacks.tick();
    expect(round()).toMatchObject({ round: 2, status: "stalled", error: "No agent ran the review" });
  });

  it("waits while the T3 thread is busy", async () => {
    const { s, task, fallbacks, advance, round, sent } = setup({ thread: "working" });
    s.tasks.move(task.id, { status: "review" }, "user");
    advance(REVIEW_GRACE_MS * 3);
    await fallbacks.tick();
    expect(sent).toEqual([]);
    expect(round()?.status).toBe("pending");
  });

  it("records why a headless review failed", async () => {
    const { s, task, fallbacks, round } = setup({
      headless: true,
      review: () => Promise.reject(new Error("Claude Code CLI (claude) not found on PATH")),
    });
    s.tasks.move(task.id, { status: "review" }, "user");
    await fallbacks.tick();
    await fallbacks.idle();
    expect(round()).toMatchObject({ status: "failed", error: "Claude Code CLI (claude) not found on PATH" });
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("review_failed");
  });

  it("leaves rounds alone once the task left Review", async () => {
    const { s, task, fallbacks, advance, round } = setup();
    s.tasks.move(task.id, { status: "review" }, "user");
    s.tasks.move(task.id, { status: "in_progress" }, "user");
    advance(PAST_GRACE);
    await fallbacks.tick();
    expect(round()?.status).toBe("pending");
  });

  it("puts a review interrupted by a restart back in the queue", () => {
    const { s, task, fallbacks, round } = setup();
    s.tasks.move(task.id, { status: "review" }, "agent");
    s.reviews.setRoundStatus(round()!.id, "running", { actor: BOARD_REVIEWER });
    fallbacks.start();
    fallbacks.stop();
    expect(round()).toMatchObject({ status: "pending", error: "The board restarted mid-review" });
  });
});
