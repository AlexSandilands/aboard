import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunGit } from "../integrations/backup.ts";
import { createGitFixture } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { createWorktreeCleanup } from "./cleanup.ts";
import { createWorktree } from "./worktrees.ts";

const DAY = 24 * 60 * 60_000;
const plan = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

// Real git processes are slow on a loaded Windows machine.
describe("Autopilot worktree cleanup", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  // The first fixture in a file builds the template repositories, a dozen git processes.
  beforeEach(() => {
    repo = createGitFixture();
  }, PROCESS_TEST_TIMEOUT);
  afterEach(() => repo.cleanup());

  async function setup() {
    const h = createTestHarness();
    const s = h.services;
    const project = s.projects.create({ title: "App", workspaceRoot: repo.checkout });
    const warnings: string[] = [];
    let clock = Date.now();
    const cleanup = createWorktreeCleanup({
      services: () => s,
      now: () => clock,
      log: {
        warn: (m: string) => {
          warnings.push(m);
        },
      },
    });
    /** A finished headless run on a new task, with its worktree. */
    const finishedRun = async (title: string, opts: { runner?: string; pr?: boolean } = {}) => {
      const task = s.tasks.create({
        projectId: project.id,
        title,
        plan,
        ...(opts.pr ? { links: [{ value: `https://github.com/acme/app/pull/${title.length}` }] } : {}),
      });
      const run = s.autopilot.record({
        automation: "test",
        candidate: { dedupeKey: title, summary: title, taskId: task.id },
        dryRun: false,
      })!;
      s.autopilot.start(run.id);
      const wt = await createWorktree(defaultRunGit, {
        repo: repo.checkout,
        root: repo.worktrees,
        taskNumber: task.number,
        runId: run.id,
      });
      s.autopilot.update(run.id, { runner: opts.runner ?? "headless", worktreePath: wt.path });
      s.autopilot.finish(run.id, {});
      return { task, path: wt.path };
    };
    return { s, cleanup, warnings, finishedRun, advance: (ms: number) => (clock += ms) };
  }

  it("keeps recent worktrees, then removes clean ones after the retention and keeps dirty ones", async () => {
    const { cleanup, warnings, finishedRun, advance } = await setup();
    const clean = await finishedRun("clean");
    const dirty = await finishedRun("dirty");
    writeFileSync(join(dirty.path, "wip.txt"), "unsaved\n");

    await cleanup.sweep();
    expect(existsSync(clean.path)).toBe(true);

    advance(8 * DAY);
    await cleanup.sweep();
    await cleanup.sweep();
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    // Logged once, not on every sweep.
    expect(warnings).toEqual([`[autopilot] kept the worktree ${dirty.path}: it has uncommitted changes`]);
  });

  it("removes a worktree as soon as the task's PR has merged", async () => {
    const { s, cleanup, finishedRun } = await setup();
    const open = await finishedRun("open-pr", { pr: true });
    const merged = await finishedRun("merged-pr", { pr: true });
    const pr = s.tasks.summary(merged.task.id).links.find((l) => l.kind === "pr")!;
    s.links.setSnapshot(pr.id, {
      state: "merged",
      title: "Change",
      checks: "passing",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: "autopilot/x",
      updatedAt: "2026-10-01T10:00:00Z",
    });

    await cleanup.sweep();
    expect(existsSync(merged.path)).toBe(false);
    expect(existsSync(open.path)).toBe(true);
  });

  it("leaves worktrees it didn't make alone", async () => {
    const { cleanup, finishedRun, advance } = await setup();
    const t3 = await finishedRun("t3", { runner: "t3" });
    advance(30 * DAY);
    await cleanup.sweep();
    expect(existsSync(t3.path)).toBe(true);
  });
});
