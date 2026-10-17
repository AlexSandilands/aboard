import {
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_REVIEW_PRS,
  fixGaveUpPrefix,
  type AutopilotRun,
  type TaskLink,
} from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { prAutopilotState } from "./fixPr.logic";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const THREAD_URL = "t3code://threads/env/thread-1";

const gaveUp = (number: number) => ({
  kind: "autopilot" as const,
  message: `${fixGaveUpPrefix(number)} 2 fix attempts used, still to fix: failing checks`,
});

const run = (over: Partial<AutopilotRun> = {}): AutopilotRun => ({
  id: "r1",
  automation: AUTOPILOT_FIX_PRS,
  taskId: "t1",
  projectId: "p1",
  dedupeKey: "fix:pr:link-1:abc:checks@abc",
  status: "running",
  summary: "fix",
  dryRun: false,
  runner: "headless",
  sessionId: null,
  threadUrl: null,
  worktreePath: null,
  costUsd: null,
  detail: null,
  exitCode: null,
  error: null,
  needsAttention: false,
  output: null,
  createdAt: minutesAgo(5),
  startedAt: minutesAgo(5),
  finishedAt: null,
  updatedAt: minutesAgo(5),
  ...over,
});

/** A run that handed the fix to a T3 thread, which ended at once. */
const t3Run = (over: Partial<AutopilotRun> = {}) =>
  run({ status: "succeeded", runner: "t3", threadUrl: THREAD_URL, finishedAt: minutesAgo(4), ...over });

const thread = (status: "working" | "idle", syncedMinutesAgo: number | null, settled = false): TaskLink =>
  ({
    id: "thread-link",
    kind: "t3_thread",
    url: THREAD_URL,
    snapshot: { title: "T", status, settled },
    syncedAt: syncedMinutesAgo === null ? null : minutesAgo(syncedMinutesAgo),
  }) as unknown as TaskLink;

describe("prAutopilotState", () => {
  const base = {
    fixOn: true,
    runs: [] as AutopilotRun[],
    task: { links: [] as TaskLink[] },
    linkId: "link-1",
    attention: [],
    prNumber: 7,
    at: NOW,
  };

  it("says nothing when Fix PRs is off for the task", () => {
    expect(prAutopilotState({ ...base, fixOn: false, runs: [run()] })).toBeNull();
    expect(prAutopilotState({ ...base, fixOn: false, attention: [gaveUp(7)] })).toBeNull();
  });

  it("says it is fixing while a Fix PRs run for this PR is queued or running", () => {
    expect(prAutopilotState({ ...base, runs: [run()] })).toBe("fixing");
    expect(prAutopilotState({ ...base, runs: [run({ status: "queued" })] })).toBe("fixing");
    // Another automation's run, another PR's, and a finished headless run say nothing about this one.
    expect(prAutopilotState({ ...base, runs: [run({ automation: AUTOPILOT_REVIEW_PRS })] })).toBeNull();
    expect(prAutopilotState({ ...base, runs: [run({ dedupeKey: "fix:pr:link-2:abc:checks@abc" })] })).toBeNull();
    expect(prAutopilotState({ ...base, runs: [run({ status: "succeeded", finishedAt: minutesAgo(1) })] })).toBeNull();
    expect(prAutopilotState({ ...base, runs: [run({ dryRun: true })] })).toBeNull();
  });

  it("keeps saying it while the T3 thread a finished run started, or was nudged into, is still working", () => {
    // The run ended at once, but the live poll has since seen the thread working.
    expect(prAutopilotState({ ...base, runs: [t3Run()], task: { links: [thread("working", 1)] } })).toBe("fixing");
    // The thread went idle, was settled, or is gone: Autopilot is done.
    expect(prAutopilotState({ ...base, runs: [t3Run()], task: { links: [thread("idle", 1)] } })).toBeNull();
    expect(prAutopilotState({ ...base, runs: [t3Run()], task: { links: [thread("working", 1, true)] } })).toBeNull();
    expect(prAutopilotState({ ...base, runs: [t3Run()], task: { links: [] } })).toBeNull();
    // Not yet seen by the poll counts for ten minutes from the run's end, as Fix PRs counts it.
    expect(prAutopilotState({ ...base, runs: [t3Run()], task: { links: [thread("idle", null)] } })).toBe("fixing");
    expect(
      prAutopilotState({
        ...base,
        runs: [t3Run({ finishedAt: minutesAgo(11) })],
        task: { links: [thread("idle", null)] },
      }),
    ).toBeNull();
    // Another PR's T3 run doesn't mark this one.
    expect(
      prAutopilotState({
        ...base,
        runs: [t3Run({ dedupeKey: "fix:pr:link-2:abc:checks@abc" })],
        task: { links: [thread("working", 1)] },
      }),
    ).toBeNull();
  });

  it("says it gave up from the task's attention reason for this PR", () => {
    expect(prAutopilotState({ ...base, attention: [gaveUp(7)] })).toBe("gave_up");
    expect(prAutopilotState({ ...base, attention: [gaveUp(8)] })).toBeNull();
    // Another PR whose number starts the same: #7, not #70.
    expect(prAutopilotState({ ...base, attention: [gaveUp(70)] })).toBeNull();
    expect(
      prAutopilotState({ ...base, attention: [{ kind: "pr_checks_failing", message: gaveUp(7).message }] }),
    ).toBeNull();
    expect(prAutopilotState({ ...base, attention: [gaveUp(7)], prNumber: undefined })).toBeNull();
  });

  it("prefers fixing to a gave-up message left from an earlier head", () => {
    expect(prAutopilotState({ ...base, runs: [run()], attention: [gaveUp(7)] })).toBe("fixing");
  });
});
