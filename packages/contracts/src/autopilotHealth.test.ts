import { describe, expect, it } from "vitest";
import { BOARD_RESTARTED_ERROR, type AutopilotRun } from "./autopilot.ts";
import {
  automationHints,
  autoPauseReason,
  engineHints,
  failureStreak,
  fixAutomationPrompt,
  ORCHESTRATE_BUSY_RUNS,
  type AutomationHintInput,
  type AutomationWeek,
} from "./autopilotHealth.ts";
import { automationTitleOf } from "./autopilotRunHistory.ts";

const run = (over: Partial<AutopilotRun> = {}): AutopilotRun => ({
  id: "r1",
  automation: "review_prs",
  taskId: null,
  projectId: "p1",
  dedupeKey: "k",
  status: "succeeded",
  summary: "Did it",
  dryRun: false,
  runner: null,
  sessionId: null,
  threadUrl: null,
  worktreePath: null,
  costUsd: null,
  detail: null,
  exitCode: null,
  error: null,
  deferred: null,
  needsAttention: false,
  dismissedAt: null,
  output: null,
  model: null,
  createdAt: "2026-11-07T10:00:00.000Z",
  startedAt: null,
  finishedAt: "2026-11-07T10:01:00.000Z",
  updatedAt: "2026-11-07T10:01:00.000Z",
  ...over,
});

const week = (over: Partial<AutomationWeek> = {}): AutomationWeek => ({
  automation: "fix_prs",
  since: "2026-11-01T00:00:00.000Z",
  runs: 0,
  failed: 0,
  deferred: 0,
  spendUsd: 0,
  wouldRun: 0,
  gaveUp: { review: 0, comments: 0 },
  days: [],
  lastRuns: [],
  ...over,
});

const input = (over: Partial<AutomationHintInput> = {}): AutomationHintInput => ({
  automation: { key: "fix_prs", title: "Fix PRs" },
  week: week(),
  engine: { prReviewRounds: 3, prCommentRounds: 5 },
  boardConfig: {},
  ...over,
});

describe("failureStreak", () => {
  it("counts failures up to the newest success", () => {
    const runs = [
      run({ status: "failed", error: "boom" }),
      run({ status: "failed", error: "older" }),
      run(),
      run({ status: "failed" }),
    ];
    expect(failureStreak(runs)).toEqual({ count: 2, last: "boom" });
  });

  it("neither counts nor stops at skips, dry runs and board restarts", () => {
    const runs = [
      run({ status: "failed", error: "a" }),
      run({ status: "skipped", deferred: "head_moved" }),
      run({ status: "failed", error: `${BOARD_RESTARTED_ERROR} while this run was going` }),
      run({ dryRun: true, status: "skipped" }),
      run({ status: "failed", error: "b" }),
      run({ status: "failed", error: "c" }),
    ];
    expect(failureStreak(runs)).toEqual({ count: 3, last: "a" });
  });

  it("says why in the reason", () => {
    expect(autoPauseReason(3, "exit 1")).toBe("Failed 3 times in a row. The last: exit 1");
    expect(autoPauseReason(3, null)).toBe("Failed 3 times in a row.");
  });
});

describe("automationHints", () => {
  it("offers to raise the attempt cap Fix PRs gave up at", () => {
    const hints = automationHints(input({ week: week({ gaveUp: { review: 4, comments: 1 } }) }));
    expect(hints).toEqual([
      expect.objectContaining({
        id: "gave_up:fix_prs:review:3",
        text: "Gave up on 4 PRs this week after 3 attempts on its review and failing checks.",
        action: { kind: "engine", label: "Raise to 4", patch: { prReviewRounds: 4 } },
      }),
    ]);
  });

  it("raises the comment cap for review comments, and never past 10", () => {
    const comments = automationHints(input({ week: week({ gaveUp: { review: 0, comments: 2 } }) }));
    expect(comments[0]?.action).toMatchObject({ patch: { prCommentRounds: 6 } });
    const capped = automationHints(
      input({ week: week({ gaveUp: { review: 3, comments: 0 } }), engine: { prReviewRounds: 10, prCommentRounds: 5 } }),
    );
    expect(capped).toEqual([]);
  });

  it("asks an agent to fix three failures in the last five runs", () => {
    const lastRuns = [
      run({ id: "a", status: "failed", error: "exited with code 1" }),
      run({ id: "b" }),
      run({ id: "c", status: "failed", error: "exited with code 1" }),
      run({ id: "d", status: "failed", error: "exited with code 1" }),
      run({ id: "e" }),
    ];
    const [hint] = automationHints(
      input({ automation: { key: "review_prs", title: "Review PRs" }, week: week({ lastRuns }) }),
    );
    expect(hint).toMatchObject({
      id: "failing:review_prs:a",
      tone: "danger",
      text: "Failed 3 of its last 5 runs, all with “exited with code 1”.",
      action: { kind: "ask_agent", label: "Ask an agent to fix" },
    });
    expect(hint?.action.kind === "ask_agent" && hint.action.prompt).toContain("Review PRs");
  });

  it("doesn't count board restarts as failures", () => {
    const restarted = run({ status: "failed", error: `${BOARD_RESTARTED_ERROR} while this run was going` });
    const lastRuns = [restarted, restarted, run({ status: "failed", error: "x" }), run({ status: "failed" })];
    expect(automationHints(input({ week: week({ lastRuns }) }))).toEqual([]);
  });

  it("offers to flag Planned tasks when Start planned has none flagged", () => {
    const planned = {
      flagged: 0,
      unflagged: [
        { id: "t11", number: 11 },
        { id: "t9", number: 9 },
        { id: "t10", number: 10 },
      ],
    };
    const [hint] = automationHints(
      input({ automation: { key: "start_planned", title: "Start planned tasks" }, planned }),
    );
    expect(hint).toMatchObject({
      text: "3 Planned tasks have a plan but aren't flagged for Autopilot, so this won't start them.",
      action: { kind: "flag_tasks", label: "Flag #9, #10 and #11", taskIds: ["t9", "t10", "t11"] },
    });
    expect(
      automationHints(input({ automation: { key: "start_planned", title: "S" }, planned: { ...planned, flagged: 1 } })),
    ).toEqual([]);
  });

  it("suggests running Orchestrate less often when it runs a lot", () => {
    const busy = input({
      automation: { key: "orchestrate", title: "Orchestrate" },
      week: week({ runs: ORCHESTRATE_BUSY_RUNS }),
      boardConfig: { everyMinutes: 30 },
    });
    expect(automationHints(busy)[0]?.action).toEqual({
      kind: "board_config",
      label: "Every 60 minutes",
      key: "everyMinutes",
      value: 60,
    });
    expect(automationHints({ ...busy, week: week({ runs: ORCHESTRATE_BUSY_RUNS - 1 }) })).toEqual([]);
  });
});

describe("engineHints", () => {
  const engine = { dailyRunCap: 10, dailySpendCapUsd: 5 };
  it("points at the limits once a daily cap is reached", () => {
    expect(engineHints({ engine, today: { agentRuns: 10, spendUsd: 0 }, date: "2026-11-07" })).toEqual([
      expect.objectContaining({ id: "daily_cap:2026-11-07", action: { kind: "open_limits", label: "See limits" } }),
    ]);
    expect(engineHints({ engine, today: { agentRuns: 1, spendUsd: 5 }, date: "d" })[0]?.text).toContain("spend cap");
    expect(engineHints({ engine, today: { agentRuns: 9, spendUsd: 4 }, date: "d" })).toEqual([]);
    expect(
      engineHints({
        engine: { dailyRunCap: null, dailySpendCapUsd: null },
        today: { agentRuns: 99, spendUsd: 99 },
        date: "d",
      }),
    ).toEqual([]);
  });
});

describe("fixAutomationPrompt", () => {
  it("lists only the failures, with their output tails", () => {
    const prompt = fixAutomationPrompt("Nightly", [
      run({ id: "f1", status: "failed", error: "boom", detail: "Traceback…" }),
      run({ id: "ok" }),
    ]);
    expect(prompt).toContain("Run f1");
    expect(prompt).toContain("Traceback…");
    expect(prompt).not.toContain("Run ok");
  });
});

describe("automationTitleOf", () => {
  const catalogue = [{ key: "review_prs", title: "Review PRs" }];
  it("never shows a raw key", () => {
    expect(automationTitleOf(catalogue, "review_prs")).toBe("Review PRs");
    expect(automationTitleOf(catalogue, "fix_pr_findings")).toBe("Fix PR findings");
    expect(automationTitleOf(catalogue, "unblock_dependents")).toBe("Unblock dependents");
    expect(automationTitleOf(catalogue, "custom:abc")).toBe("Removed custom automation");
    expect(automationTitleOf(catalogue, "nightly_sync")).toBe("Nightly sync");
  });
});
