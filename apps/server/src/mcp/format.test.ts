import { describe, expect, it } from "vitest";
import {
  deriveCurrentStep,
  EMPTY_MODEL_TIERS,
  type PlanPhase,
  type StepStatus,
  type TaskDetail,
  type TaskStatus,
} from "@repo/contracts";
import type { SessionTranscript } from "../integrations/sessionTranscript.ts";
import { STALE_PLAN_MS, batchedCompletionHint, progressHints, renderTranscript, runsOnText } from "./format.ts";

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

describe("runsOnText", () => {
  const settings = {
    modelTiers: EMPTY_MODEL_TIERS,
    modelProfiles: [{ id: "codex61", name: "Codex 6.1", labels: ["codex61"], description: null, t3: null }],
  };

  it("names the custom model a label picks, and nothing when the tier decides", () => {
    expect(runsOnText({ labels: ["codex61"], suggestedModel: { tier: "deep", reason: null } }, settings)).toBe(
      "Codex 6.1, from label codex61",
    );
    expect(runsOnText({ labels: ["ui"], suggestedModel: { tier: "deep", reason: null } }, settings)).toBeNull();
  });
});

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

describe("renderTranscript", () => {
  const transcript = (page: Partial<SessionTranscript["page"]>, label: string | null = null): SessionTranscript => ({
    taskNumber: 7,
    sessionId: "s-1",
    label,
    stats: {
      turns: 1,
      toolCalls: 2,
      errors: 0,
      denials: 1,
      retries: 0,
      interruptions: 0,
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-01T10:12:00.000Z",
      durationMs: 12 * 60_000,
    },
    page: { lines: [], offset: 0, total: 0, next: null, ...page },
  });

  it("puts the totals on top, then the page and where the next one starts", () => {
    const out = renderTranscript(
      transcript({ lines: ["[user #1] Fix it", "[tool] Read /a.ts"], offset: 0, total: 3, next: 2 }, "Implementing #7"),
    );
    expect(out.split("\n")).toEqual([
      'Transcript of Claude Code session s-1 "Implementing #7" for #7',
      "1 turn, 2 tool calls, 0 errors, 1 denied, 0 retries, 0 interruptions, 12m",
      "From 2026-01-01T10:00:00.000Z to 2026-01-01T10:12:00.000Z",
      "Entries 1-2 of 3 (offset 0):",
      "",
      "[user #1] Fix it",
      "[tool] Read /a.ts",
      "",
      "More follows: call again with offset: 2.",
    ]);
    const last = renderTranscript(transcript({ lines: ["[assistant] Done."], offset: 2, total: 3, next: null }));
    expect(last).toContain("Entries 3-3 of 3 (offset 2):");
    expect(last.endsWith("End of transcript.")).toBe(true);
  });

  it("says when there is nothing, or the offset is past the end", () => {
    expect(renderTranscript(transcript({})).endsWith("The transcript has no messages.")).toBe(true);
    const past = renderTranscript(transcript({ offset: 9, total: 4 }));
    expect(past).toContain("Offset 9 is past the end: the transcript has 4 entries, offsets 0 to 3.");
    expect(past).not.toContain("Entries");
  });

  it("names the other linked sessions when it read the newest", () => {
    const out = renderTranscript({ ...transcript({}), otherSessions: ['s-0 "Planning"'] });
    expect(out.split("\n")[1]).toBe(
      'The newest of 2 linked Claude Code sessions; pass session to read another: s-0 "Planning".',
    );
  });

  it("redacts the session's label", () => {
    const value = "x7".repeat(8);
    const out = renderTranscript(transcript({}, `run ${["TOK", "EN"].join("")}=${value}`));
    expect(out.includes(value)).toBe(false);
    expect(out.includes("[redacted]")).toBe(true);
  });
});
