import { describe, expect, it } from "vitest";
import { deriveCurrentStep, type PlanPhase, type StepStatus, type TaskDetail, type TaskStatus } from "@repo/contracts";
import { STALE_PLAN_MS, batchedCompletionHint, progressHints } from "./format.ts";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function step(id: string, status: StepStatus, over: { updatedAt?: string; startedAt?: string | null } = {}) {
  return {
    id,
    phaseId: "p1",
    title: `Step ${id}`,
    notes: null,
    status,
    position: id,
    startedAt: over.startedAt === undefined ? (status === "todo" ? null : ago(0)) : over.startedAt,
    completedAt: null,
    updatedAt: over.updatedAt ?? ago(0),
  };
}

function phasesOf(...steps: ReturnType<typeof step>[]): PlanPhase[] {
  return [{ id: "p1", title: "Build", position: "a", steps }];
}

function task(status: TaskStatus, phases: PlanPhase[], over: Partial<TaskDetail> = {}): TaskDetail {
  const all = phases.flatMap((p) => p.steps);
  return {
    number: 7,
    kind: "task",
    status,
    archivedAt: null,
    resolution: null,
    phases,
    progress: { done: all.filter((s) => s.status === "done").length, total: all.length },
    currentStep: deriveCurrentStep(phases),
    ...over,
  } as TaskDetail;
}

describe("progressHints", () => {
  it("asks to start the current step when an In Progress task has none started", () => {
    const hints = progressHints(task("in_progress", phasesOf(step("a", "done"), step("b", "todo"))), NOW);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('update_step(task: "#7", step: "1.2", status: "in_progress")');
  });

  it("stays quiet when a step is in progress and recently updated", () => {
    expect(progressHints(task("in_progress", phasesOf(step("a", "in_progress"), step("b", "todo"))), NOW)).toEqual([]);
  });

  it("stays quiet when the current step is blocked or every step is done", () => {
    expect(progressHints(task("in_progress", phasesOf(step("a", "blocked"), step("b", "todo"))), NOW)).toEqual([]);
    expect(progressHints(task("in_progress", phasesOf(step("a", "done"), step("b", "skipped"))), NOW)).toEqual([]);
  });

  it("flags a stale plan after 30 minutes without a step change", () => {
    const stale = phasesOf(step("a", "in_progress", { updatedAt: ago(STALE_PLAN_MS + 60_000) }));
    const [hint] = progressHints(task("in_progress", stale), NOW);
    expect(hint).toContain("31 minutes");
    expect(hint).toContain('update_step(task: "#7", step: "1.1", status: "done")');
    const fresh = phasesOf(step("a", "in_progress", { updatedAt: ago(STALE_PLAN_MS - 60_000) }));
    expect(progressHints(task("in_progress", fresh), NOW)).toEqual([]);
  });

  it("lists open steps on a task in Review, and on Done only when closing", () => {
    const open = phasesOf(step("a", "done"), step("b", "todo"), step("c", "in_progress"));
    const [hint] = progressHints(task("review", open), NOW);
    expect(hint).toContain("2 plan step(s) are still open");
    expect(hint).toContain("1.2 Step b [todo]");
    expect(hint).toContain('update_plan(task: "#7"');
    expect(progressHints(task("done", open), NOW)).toEqual([]);
    expect(progressHints(task("done", open), NOW, { closing: true })).toHaveLength(1);
    expect(progressHints(task("review", phasesOf(step("a", "done"), step("b", "skipped"))), NOW)).toEqual([]);
  });

  it("says nothing for Backlog, Planned, epics, archived or closed tasks, or tasks without a plan", () => {
    const open = phasesOf(step("a", "todo"));
    expect(progressHints(task("backlog", open), NOW)).toEqual([]);
    expect(progressHints(task("planned", open), NOW)).toEqual([]);
    expect(progressHints(task("in_progress", open, { kind: "epic" }), NOW)).toEqual([]);
    expect(progressHints(task("in_progress", open, { archivedAt: ago(0) }), NOW)).toEqual([]);
    expect(progressHints(task("review", open, { resolution: "wont_do" }), NOW)).toEqual([]);
    expect(progressHints(task("in_progress", []), NOW)).toEqual([]);
  });
});

describe("batchedCompletionHint", () => {
  const before = phasesOf(step("a", "todo"), step("b", "todo"), step("c", "in_progress"));

  it("flags two or more steps that went straight to done without being started", () => {
    const after = phasesOf(
      step("a", "done", { startedAt: null }),
      step("b", "done", { startedAt: null }),
      step("c", "todo"),
    );
    const hint = batchedCompletionHint(before, after, '"#7"');
    expect(hint).toContain("2 steps went straight to done");
    expect(hint).toContain("1.1 Step a; 1.2 Step b");
    expect(hint).toContain('update_step(task: "#7"');
  });

  it("ignores steps that were started, were already done, or are alone", () => {
    const started = phasesOf(step("a", "done"), step("b", "done"), step("c", "in_progress"));
    expect(batchedCompletionHint(before, started, '"#7"')).toBeNull();
    const alone = phasesOf(step("a", "done", { startedAt: null }), step("b", "todo"), step("c", "in_progress"));
    expect(batchedCompletionHint(before, alone, '"#7"')).toBeNull();
    const finished = phasesOf(step("a", "done", { startedAt: null }), step("b", "done", { startedAt: null }));
    expect(batchedCompletionHint(finished, finished, '"#7"')).toBeNull();
  });
});
