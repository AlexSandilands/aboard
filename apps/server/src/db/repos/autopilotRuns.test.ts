import { AUTOPILOT_REVIEW_PRS, type AutopilotRun } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createRepos } from "./index.ts";

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
  const task = h.services.tasks.create({ projectId: project.id, title: "One", plan });
  const other = h.services.tasks.create({ projectId: project.id, title: "Two", plan });
  const repo = createRepos(h.db).autopilotRuns;
  let n = 0;
  const insert = (over: Partial<AutopilotRun> & { handoff?: string; counts?: Partial<Record<string, number>> }) => {
    const { handoff = "clean", counts = {}, ...rest } = over;
    n += 1;
    repo.insert({
      id: `run-${n}`,
      automation: AUTOPILOT_REVIEW_PRS,
      taskId: task.id,
      projectId: project.id,
      dedupeKey: `k${n}`,
      status: "succeeded",
      summary: "",
      dryRun: false,
      runner: null,
      sessionId: null,
      threadUrl: null,
      worktreePath: null,
      costUsd: null,
      detail: null,
      exitCode: null,
      error: null,
      needsAttention: false,
      output: { kind: "pr_review", handoff, counts: { blocking: 0, major: 0, minor: 0, nit: 0, ...counts } },
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:00:00.000Z",
      finishedAt: "2026-01-01T10:01:00.000Z",
      updatedAt: "2026-01-01T10:01:00.000Z",
      ...rest,
    });
  };
  return { repo, task, other, insert };
}

describe("autopilotRuns.cleanPrReviewTimes", () => {
  it("is the start of the newest clean, succeeded, real Review PRs run, per task", () => {
    const { repo, task, other, insert } = setup();
    insert({ startedAt: "2026-01-01T11:00:00.000Z" });
    insert({ startedAt: "2026-01-01T12:00:00.000Z" });
    insert({ startedAt: "2026-01-01T13:00:00.000Z", taskId: other.id });
    expect(repo.cleanPrReviewTimes([task.id, other.id])).toEqual(
      new Map([
        [task.id, "2026-01-01T12:00:00.000Z"],
        [other.id, "2026-01-01T13:00:00.000Z"],
      ]),
    );
    expect(repo.cleanPrReviewTimes([other.id])).toEqual(new Map([[other.id, "2026-01-01T13:00:00.000Z"]]));
  });

  it("skips runs that failed, were dry, belong to another automation or asked for fixes", () => {
    const { repo, task, insert } = setup();
    insert({ status: "failed" });
    insert({ dryRun: true });
    insert({ automation: "fix_prs" });
    insert({ handoff: "fix" });
    insert({ handoff: "gave_up" });
    insert({ output: null });
    expect(repo.cleanPrReviewTimes([task.id]).size).toBe(0);
  });

  it("skips a clean hand-off that still reported blocking or major issues, but not minor ones", () => {
    const { repo, task, insert } = setup();
    insert({ counts: { major: 1 }, startedAt: "2026-01-01T12:00:00.000Z" });
    insert({ counts: { blocking: 1 }, startedAt: "2026-01-01T13:00:00.000Z" });
    expect(repo.cleanPrReviewTimes([task.id]).size).toBe(0);
    insert({ counts: { minor: 2 }, startedAt: "2026-01-01T11:00:00.000Z" });
    expect(repo.cleanPrReviewTimes([task.id]).get(task.id)).toBe("2026-01-01T11:00:00.000Z");
  });
});
