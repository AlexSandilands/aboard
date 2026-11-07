import { AUTOPILOT_MERGE_EPIC_PRS, type PrSnapshot, type TaskLink } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../errors.ts";
import type { DefaultBranchMergeInput } from "../../integrations/gitHost.ts";
import { NO_GIT_HOSTS, type GitHostActions } from "../../integrations/gitHosts.ts";
import { mergeTaskPr } from "../../integrations/mergeTaskPr.ts";
import { MergeTargetError } from "../../integrations/prMerge.ts";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { NO_RUNNER } from "../types.ts";
import { mergeEpicPrs } from "./mergeEpicPrs.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it", status: "done" as const }] }] };
const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "fix: the thing",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  mergeState: "clean",
  headRef: "fix/thing",
  baseRef: "main",
  updatedAt: null,
  headOid: SHA_A,
  canMerge: true,
  mergeMethods: ["squash"],
  ...over,
});

const engines: AutopilotEngine[] = [];
let clock = Date.parse("2026-11-07T12:00:00Z");
/** Moves the clock on, so a read after a merge is later than it, as it is for real. */
const tick = () => vi.setSystemTime((clock += 1000));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  tick();
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

function setup() {
  const merged: Array<{ linkId: string; input: DefaultBranchMergeInput }> = [];
  const reread: string[] = [];
  let mergeError: Error | null = null;
  const h = createTestHarness({ integrations: { automations: [mergeEpicPrs] } });
  const s = h.services;
  // The real mergeTaskPr, over a fake host merge: what Into main calls in the app.
  const merges = {
    mergeIntoDefaultBranch: async (link: TaskLink, input: DefaultBranchMergeInput) => {
      merged.push({ linkId: link.id, input });
      if (mergeError) throw mergeError;
      tick();
      s.links.setSnapshot(link.id, snapshot({ state: "merged", headOid: input.headOid }));
    },
  };
  const gitHosts: GitHostActions = {
    ...NO_GIT_HOSTS,
    mergeAutoMergeTask: (taskId, input, actor) =>
      mergeTaskPr({ services: s, merges, hosts: { resolve: async () => null } }, taskId, input, actor),
    rereadPr: async (link) => {
      reread.push(link.id);
      tick();
      const current = s.links.get(link.id);
      if (current.kind === "pr" && current.snapshot)
        s.links.setSnapshot(link.id, { ...current.snapshot, title: `${current.snapshot.title} ` });
    },
  };
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: NO_RUNNER,
    gitHosts,
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const flaggedTask = (n: number, over: { autoMerge?: boolean; epicId?: string } = {}) => {
    const task = s.tasks.create({
      projectId: project.id,
      title: `Task ${n}`,
      plan,
      ...(over.epicId ? { epicId: over.epicId } : {}),
      links: [{ value: `https://github.com/acme/app/pull/${n}` }],
    });
    s.tasks.update(task.id, { autoReview: false, autoMerge: over.autoMerge ?? true }, "user");
    s.tasks.move(task.id, { status: "review" }, "agent");
    return task;
  };
  const linkOf = (taskId: string) => s.tasks.summary(taskId).links.find((l) => l.kind === "pr")!.id;
  const setPr = (taskId: string, over: Partial<PrSnapshot> = {}) => s.links.setSnapshot(linkOf(taskId), snapshot(over));
  const pass = async () => {
    tick();
    await engine.pass();
    await engine.idle();
  };
  const turnOn = (intoMain = true) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_MERGE_EPIC_PRS, { mode: "on", config: { intoMain } });
  const runs = (taskId: string) =>
    s.autopilot.runsForTask(taskId).filter((r) => r.automation === AUTOPILOT_MERGE_EPIC_PRS);
  return {
    ...h,
    s,
    project,
    flaggedTask,
    linkOf,
    setPr,
    pass,
    turnOn,
    runs,
    merged,
    reread,
    failMerge: (e: Error | null) => (mergeError = e),
  };
}

describe("Merge ready PRs: Into main", () => {
  it("merges a flagged task's ready PR into main through merge_task_pr's path, and the task goes Done", async () => {
    const { s, flaggedTask, linkOf, setPr, pass, turnOn, runs, merged } = setup();
    const task = flaggedTask(4);
    setPr(task.id);
    turnOn();
    await pass();
    expect(merged).toEqual([{ linkId: linkOf(task.id), input: { base: "main", headOid: SHA_A, method: "squash" } }]);
    expect(runs(task.id)[0]).toMatchObject({
      status: "succeeded",
      dedupeKey: `main:${linkOf(task.id)}:${SHA_A}`,
      summary: "Merged PR #4 into main (squash)",
    });
    expect(s.tasks.summary(task.id).status).toBe("done");
    const notes = s.tasks.detail(task.id).events.filter((e) => e.type === "note");
    expect(JSON.stringify(notes)).toContain("with Autopilot's Merge ready PRs: auto-merge is on for this task");
    await pass();
    expect(merged).toHaveLength(1);
  });

  it("is off by default: with the automation on but Into main off, a flagged task's PR isn't merged", async () => {
    const { s, flaggedTask, setPr, pass, project, runs, merged } = setup();
    const task = flaggedTask(4);
    setPr(task.id);
    s.autopilot.setScope("project", project.id, AUTOPILOT_MERGE_EPIC_PRS, { mode: "on" });
    await pass();
    expect(merged).toEqual([]);
    expect(runs(task.id)).toEqual([]);
  });

  it("follows an epic's own Into main over the project's", async () => {
    const { s, project, flaggedTask, setPr, pass, turnOn, runs, merged } = setup();
    const epic = s.tasks.createEpic({ projectId: project.id, title: "Billing" }, [], "user");
    const task = flaggedTask(4, { epicId: epic.id });
    setPr(task.id);
    turnOn();
    s.autopilot.setScope("epic", epic.id, AUTOPILOT_MERGE_EPIC_PRS, { config: { intoMain: false } }, project.id);
    await pass();
    expect(merged).toEqual([]);
    expect(runs(task.id)).toEqual([]);
    s.autopilot.setScope("epic", epic.id, AUTOPILOT_MERGE_EPIC_PRS, { mode: "inherit", config: {} }, project.id);
    await pass();
    expect(merged).toHaveLength(1);
  });

  it("never merges a task that isn't flagged Auto-merge", async () => {
    const { flaggedTask, setPr, pass, turnOn, runs, merged } = setup();
    const task = flaggedTask(4, { autoMerge: false });
    setPr(task.id);
    turnOn();
    await pass();
    expect(merged).toEqual([]);
    expect(runs(task.id)).toEqual([]);
  });

  it("waits while it isn't reviewed, changes are requested, checks are red, it conflicts or GitHub hasn't said", async () => {
    const { s, flaggedTask, setPr, pass, turnOn, runs, merged } = setup();
    const task = flaggedTask(4);
    turnOn();
    for (const over of [
      { reviewDecision: "changes_requested" as const },
      { checks: "failing" as const },
      { checks: "pending" as const },
      { mergeable: "conflicting" as const },
      { mergeable: "unknown" as const },
      { state: "draft" as const },
    ]) {
      setPr(task.id, over);
      await pass();
    }
    expect(merged).toEqual([]);
    // Green and clean, but its local review is still going.
    s.reviews.openRound(task.id, { trigger: "manual", actor: "user", force: true });
    setPr(task.id);
    await pass();
    expect(merged).toEqual([]);
    expect(runs(task.id)).toEqual([]);
  });

  it("re-checks before merging: a head that moved since the check is skipped, and the new head merges", async () => {
    const { s, flaggedTask, linkOf, setPr, pass, turnOn, runs, merged } = setup();
    const task = flaggedTask(4);
    setPr(task.id);
    turnOn();
    const check = await mergeEpicPrs.check({
      services: s,
      engine: s.autopilot.engine(),
      now: new Date(),
      projects: [{ project: s.projects.get(task.projectId), config: { intoMain: true } }],
      board: null,
    });
    const candidate = check.find((c) => c.taskId === task.id)!;
    setPr(task.id, { headOid: SHA_B });
    const run = s.autopilot.record({ automation: AUTOPILOT_MERGE_EPIC_PRS, candidate, dryRun: false })!;
    const result = await mergeEpicPrs.act(candidate, {
      services: s,
      runner: NO_RUNNER,
      gitHosts: { ...NO_GIT_HOSTS, mergeAutoMergeTask: () => Promise.reject(new Error("must not merge")) },
      engine: s.autopilot.engine(),
      boardUrl: "",
      config: { intoMain: true },
      run,
      actor: "autopilot",
      update: () => {},
    });
    expect(result).toMatchObject({ status: "skipped", summary: "PR #4 moved on before the merge" });
    s.autopilot.start(run.id);
    s.autopilot.finish(run.id, result);
    turnOn();
    await pass();
    expect(merged.map((m) => m.input.headOid)).toEqual([SHA_B]);
    expect(runs(task.id)[0]).toMatchObject({ status: "succeeded", dedupeKey: `main:${linkOf(task.id)}:${SHA_B}` });
  });

  it("merges one PR at a time per repository, and the next only once it has been read again after the merge", async () => {
    const { s, flaggedTask, linkOf, setPr, pass, turnOn, merged, reread } = setup();
    const first = flaggedTask(4);
    const second = flaggedTask(5);
    setPr(first.id);
    setPr(second.id, { headOid: SHA_B });
    turnOn();
    await pass();
    // #4 first (lower number); #5's PR was read again right after, so the next pass may take it.
    expect(merged.map((m) => m.linkId)).toEqual([linkOf(first.id)]);
    expect(reread).toEqual([linkOf(second.id)]);
    await pass();
    expect(merged.map((m) => m.linkId)).toEqual([linkOf(first.id), linkOf(second.id)]);
    expect(s.tasks.summary(second.id).status).toBe("done");
  });

  it("holds a PR not read since the last merge into main, and puts a task blocked by another flagged one after it", async () => {
    const { s, flaggedTask, linkOf, setPr, pass, turnOn, merged } = setup();
    const blocked = flaggedTask(4);
    const blocker = flaggedTask(5);
    s.tasks.update(blocked.id, { addBlockedBy: [blocker.id] }, "user");
    setPr(blocked.id);
    setPr(blocker.id, { headOid: SHA_B });
    // Another PR merged into main by hand, after both were last read.
    const other = flaggedTask(6);
    s.tasks.update(other.id, { autoMerge: false }, "user");
    setPr(other.id);
    tick();
    setPr(other.id, { state: "merged" });
    turnOn();
    await pass();
    expect(merged).toEqual([]);
    tick();
    setPr(blocker.id, { headOid: SHA_B, title: "read again" });
    setPr(blocked.id, { title: "read again" });
    await pass();
    expect(merged.map((m) => m.linkId)).toEqual([linkOf(blocker.id)]);
  });

  it("flags a task only the user can unblock once per head, and nothing is tried", async () => {
    const { s, flaggedTask, setPr, pass, turnOn, runs, merged } = setup();
    const task = flaggedTask(4);
    setPr(task.id, { reviewDecision: "review_required", mergeState: "blocked" });
    turnOn();
    await pass();
    await pass();
    expect(merged).toEqual([]);
    expect(runs(task.id)).toEqual([
      expect.objectContaining({
        status: "skipped",
        needsAttention: true,
        summary: expect.stringContaining(
          `won't merge #${s.tasks.summary(task.id).number} by itself: it still needs an approving review`,
        ),
      }),
    ]);
    expect(s.tasks.summary(task.id).attention.length).toBeGreaterThan(0);
  });

  it("tries a race again, and flags a merge the host keeps refusing or a target it may never merge into", async () => {
    const { s, flaggedTask, setPr, pass, turnOn, runs, failMerge } = setup();
    const task = flaggedTask(4);
    setPr(task.id);
    turnOn();
    failMerge(new AppError("CONFLICT", "The PR moved on to abc1234 since it was checked"));
    await pass();
    expect(runs(task.id)[0]).toMatchObject({ status: "skipped", output: { retry: true } });
    failMerge(new AppError("VALIDATION", "GitHub says the PR can't be merged yet (BLOCKED): a branch rule"));
    await pass();
    expect(runs(task.id)[0]).toMatchObject({
      status: "skipped",
      needsAttention: true,
      summary: expect.stringMatching(/^Ready to merge into main: .* Merge it yourself\.$/),
    });
    await pass();
    expect(runs(task.id)).toHaveLength(2);

    const other = flaggedTask(5);
    setPr(other.id, { baseRef: "release/1" });
    failMerge(new MergeTargetError("The PR targets release/1, not the default branch (main)"));
    await pass();
    expect(runs(other.id)[0]).toMatchObject({ status: "failed", needsAttention: true });
    expect(s.tasks.summary(other.id).status).toBe("review");
  });
});
