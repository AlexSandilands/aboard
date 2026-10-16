import type { PlanInput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const plan: PlanInput = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = s.tasks.create({ projectId: project.id, title: "Feature", plan });
  return { ...h, s, project, task };
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("reviews", () => {
  it("opens rounds as pending and records findings with labels", () => {
    const { s, task } = setup();
    const opened = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    expect(opened).toMatchObject({ round: 1, cycle: 1, status: "pending", skill: "aboard-review", findings: [] });
    expect(s.tasks.summary(task.id).review?.state).toBe("pending");

    const submitted = s.reviews.submit(
      task.id,
      {
        summary: "Two issues",
        headSha: "abc123",
        findings: [
          { severity: "blocking", title: "Crash on empty input", file: "src/a.ts", line: 12 },
          { severity: "nit", title: "Typo" },
        ],
      },
      "reviewer",
    );
    expect(submitted).toMatchObject({ status: "submitted", reviewer: "reviewer", headSha: "abc123" });
    expect(submitted.findings.map((f) => [f.label, f.severity, f.status])).toEqual([
      ["R1.1", "blocking", "open"],
      ["R1.2", "nit", "open"],
    ]);
    expect(s.tasks.summary(task.id).review).toMatchObject({
      state: "changes_requested",
      open: { blocking: 1, nit: 1 },
    });
    expect(s.tasks.detail(task.id).events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["review_opened", "review_submitted"]),
    );
  });

  it("resolves findings by label, needing a note to decline", () => {
    const { s, task } = setup();
    s.reviews.submit(
      task.id,
      {
        findings: [
          { severity: "blocking", title: "A" },
          { severity: "major", title: "B" },
        ],
      },
      "reviewer",
    );
    s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed", note: "Guarded" }, "agent");
    expectCode(() => s.reviews.resolveFinding(task.id, "r1.2", { status: "wont_fix" }, "agent"), "VALIDATION");
    const declined = s.reviews.resolveFinding(task.id, "r1.2", { status: "wont_fix", note: "By design" }, "agent");
    expect(declined).toMatchObject({ status: "wont_fix", resolutionNote: "By design", resolvedBy: "agent" });
    expect(s.tasks.summary(task.id).review?.state).toBe("fixed");
    expectCode(() => s.reviews.resolveFinding(task.id, "R9.1", { status: "fixed" }, "agent"), "NOT_FOUND");

    const reopened = s.reviews.resolveFinding(task.id, "R1.1", { status: "open" }, "user");
    expect(reopened).toMatchObject({ status: "open", resolutionNote: null, resolvedBy: null });
  });

  describe("the board opens the next round", () => {
    const gating = {
      findings: [
        { severity: "blocking" as const, title: "A" },
        { severity: "major" as const, title: "B" },
        { severity: "minor" as const, title: "C" },
      ],
    };

    it("when the last blocking or major finding is resolved, fixed or declined", () => {
      const { s, task } = setup();
      s.settings.update({ autoReview: true });
      s.reviews.submit(task.id, gating, "reviewer");
      s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
      // One gating finding is still open, and a minor one doesn't count.
      expect(s.reviews.list(task.id)).toHaveLength(1);
      s.reviews.resolveFinding(task.id, "R1.2", { status: "wont_fix", note: "By design" }, "agent");
      const rounds = s.reviews.list(task.id);
      expect(rounds).toHaveLength(2);
      expect(rounds[1]).toMatchObject({ round: 2, status: "pending", trigger: "manual", openedBy: "board" });
      expect(s.tasks.summary(task.id).review?.state).toBe("pending");
      expect(s.tasks.detail(task.id).events.map((e) => e.type)).toContain("review_opened");
    });

    it("once: resolving more findings while the round is open doesn't open another", () => {
      const { s, task } = setup();
      s.settings.update({ autoReview: true });
      s.reviews.submit(task.id, gating, "reviewer");
      s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
      s.reviews.resolveFinding(task.id, "R1.2", { status: "fixed" }, "agent");
      s.reviews.resolveFinding(task.id, "R1.3", { status: "fixed" }, "agent");
      s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed", note: "again" }, "agent");
      expect(s.reviews.list(task.id)).toHaveLength(2);
    });

    it("not at the round limit, not on reopening, not after a clean round, and not with auto-review off", () => {
      const { s, task } = setup();
      s.settings.update({ autoReview: true, reviewMaxRounds: 1 });
      s.reviews.submit(task.id, { findings: [{ severity: "major", title: "A" }] }, "reviewer");
      s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
      expect(s.reviews.list(task.id)).toHaveLength(1);

      s.settings.update({ reviewMaxRounds: 3 });
      s.reviews.resolveFinding(task.id, "R1.1", { status: "open" }, "agent");
      expect(s.reviews.list(task.id)).toHaveLength(1);

      s.settings.update({ autoReview: false });
      s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed" }, "agent");
      expect(s.reviews.list(task.id)).toHaveLength(1);
      // A task override turns it back on for this task alone.
      s.tasks.update(task.id, { autoReview: true }, "user");
      s.reviews.resolveFinding(task.id, "R1.1", { status: "fixed", note: "again" }, "agent");
      expect(s.reviews.list(task.id)).toHaveLength(2);

      s.reviews.submit(task.id, { findings: [{ severity: "minor", title: "B" }] }, "reviewer");
      s.reviews.resolveFinding(task.id, "R2.1", { status: "fixed" }, "agent");
      expect(s.reviews.list(task.id)).toHaveLength(2);
    });
  });

  it("refuses a second submission to the same round", () => {
    const { s, task } = setup();
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    expect(s.tasks.summary(task.id).review?.state).toBe("clean");
    expectCode(() => s.reviews.submit(task.id, { round: 1, findings: [] }, "reviewer"), "CONFLICT");
  });

  it("opens a round itself when a reviewer submits without one", () => {
    const { s, task } = setup();
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    const second = s.reviews.submit(task.id, { findings: [{ severity: "minor", title: "x" }] }, "reviewer");
    expect(second.round).toBe(2);
  });

  it("returns the pending round instead of opening another", () => {
    const { s, task } = setup();
    const first = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    expect(s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" }).id).toBe(first.id);
  });

  it("caps manual rounds per cycle unless forced, and a move starts a new cycle", () => {
    const { s, task } = setup();
    s.settings.update({ reviewMaxRounds: 2 });
    const gating = { findings: [{ severity: "blocking" as const, title: "x" }] };
    s.reviews.submit(task.id, gating, "reviewer");
    s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, gating, "reviewer");
    expect(s.tasks.summary(task.id).review).toMatchObject({ state: "stuck", round: 2 });
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("review_stuck");
    expectCode(() => s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" }), "VALIDATION");

    expect(s.reviews.openRound(task.id, { trigger: "manual", actor: "user", force: true }).round).toBe(3);
    const moved = s.reviews.openRound(task.id, { trigger: "move", actor: "agent" });
    expect(moved).toMatchObject({ round: 3, cycle: 2, trigger: "move" });
  });

  it("re-derives stuck when the round limit changes", () => {
    const { s, task, events } = setup();
    s.reviews.submit(task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");
    expect(s.tasks.summary(task.id).review?.state).toBe("changes_requested");
    events.length = 0;
    s.settings.update({ reviewMaxRounds: 1 });
    expect(s.tasks.summary(task.id).review?.state).toBe("stuck");
    expect(events.some((e) => e.type === "task.upserted" && e.task.id === task.id)).toBe(true);
  });

  it("lets the board's fallbacks move a round through running, stalled and failed", () => {
    const { s, task } = setup();
    const round = s.reviews.openRound(task.id, { trigger: "move", actor: "agent" });
    s.reviews.setRoundStatus(round.id, "running", { actor: "board" });
    expectCode(() => s.reviews.openRound(task.id, { trigger: "manual", actor: "user" }), "CONFLICT");
    s.reviews.setRoundStatus(round.id, "failed", { actor: "board", error: "CLI not found" });
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("review_failed");
    expect(s.reviews.list(task.id)[0]).toMatchObject({ status: "failed", error: "CLI not found" });

    // Retrying reuses the failed round rather than burning a round number.
    const retried = s.reviews.openRound(task.id, { trigger: "manual", actor: "user" });
    expect(retried).toMatchObject({ round: 1, status: "pending", error: null });
  });

  it("only changes a round's status from the one the caller expects", () => {
    const { s, task } = setup();
    const opened = s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(task.id, { findings: [] }, "reviewer");
    expect(s.reviews.setRoundStatus(opened.id, "stalled", { actor: "board", from: ["pending"] })).toBeNull();
    expect(s.reviews.markNudged(opened.id, "board")).toBe(false);
    expect(s.reviews.list(task.id)[0]).toMatchObject({ status: "submitted", nudgedAt: null });
  });

  it("doesn't block a move to Review while the board is reviewing", () => {
    const { s, task } = setup();
    s.settings.update({ autoReview: true });
    s.tasks.move(task.id, { status: "review" }, "agent");
    const round = s.reviews.list(task.id)[0]!;
    s.reviews.setRoundStatus(round.id, "running", { actor: "board" });
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    expect(s.tasks.move(task.id, { status: "review" }, "agent").status).toBe("review");
    expect(s.reviews.list(task.id)).toHaveLength(1);
  });

  it("keeps the badge but drops the call to action once the task is done", () => {
    const { s, task } = setup();
    s.settings.update({ reviewMaxRounds: 1 });
    s.reviews.submit(task.id, { findings: [{ severity: "blocking", title: "x" }] }, "reviewer");
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("review_stuck");
    const done = s.tasks.move(task.id, { status: "done" }, "user");
    expect(done.review?.state).toBe("stuck");
    expect(done.attention).toEqual([]);
  });

  it("resolves auto-review and the skill from task, project and global settings", () => {
    const { s, project, task } = setup();
    expect(s.reviews.effectiveAutoReview(task.id)).toBe(false);
    s.settings.update({ autoReview: true });
    expect(s.reviews.effectiveAutoReview(task.id)).toBe(true);
    s.tasks.update(task.id, { autoReview: false }, "user");
    expect(s.reviews.effectiveAutoReview(task.id)).toBe(false);
    expect(s.tasks.summary(task.id).autoReview).toBe(false);

    expect(s.reviews.skillFor(task.id)).toEqual({ source: "builtin" });
    const global = {
      source: "global" as const,
      name: "review-loop",
      path: "/home/me/.claude/skills/review-loop/SKILL.md",
    };
    s.settings.update({ reviewSkill: global });
    expect(s.reviews.skillFor(task.id)).toEqual(global);
    const local = {
      source: "project" as const,
      name: "pr-review",
      path: "/work/alpha/.claude/skills/pr-review/SKILL.md",
    };
    s.projects.update(project.id, { reviewSkill: local });
    expect(s.reviews.skillFor(task.id)).toEqual(local);
    expect(s.reviews.openRound(task.id, { trigger: "manual", actor: "agent" }).skill).toBe("pr-review");
  });

  it("includes rounds in the task detail and drops them with the task", () => {
    const { s, task } = setup();
    s.reviews.submit(task.id, { findings: [{ severity: "minor", title: "x" }] }, "reviewer");
    expect(s.tasks.detail(task.id).reviews).toHaveLength(1);
    s.tasks.update(task.id, { archived: true }, "user");
    s.tasks.delete(task.id, "user");
    expect(s.reviews.list(task.id)).toEqual([]);
  });
});
