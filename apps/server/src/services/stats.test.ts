import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepos } from "../db/repos/index.ts";
import { createTestHarness } from "../test/harness.ts";
import { weekBoundaries } from "./stats.ts";

// Local time throughout, as the weeks are: 2026-10-12 is a Monday.
const at = (day: number, hour = 9, month = 9) => new Date(2026, month, day, hour);
const HOUR = 3_600_000;
const plan = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

afterEach(() => vi.useRealTimers());

function setup() {
  // Only Date is ours: everything is stamped with it, and the clock is moved by hand.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(14, 12));
  const h = createTestHarness();
  const s = h.services;
  const alpha = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const beta = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const clock = (when: Date) => vi.setSystemTime(when);
  const task = (projectId: string, title: string) => s.tasks.create({ projectId, title, plan });
  const finish = (id: string) => s.tasks.move(id, { status: "done" }, "agent");
  const stats = (weeks: 4 | 12 | 52 = 4, projectId?: string) => s.stats.weekly(weeks, projectId);
  const values = (name: string, weeks: 4 | 12 | 52 = 4, projectId?: string) => stats(weeks, projectId).series[name]!;
  return { ...h, s, alpha, beta, clock, task, finish, stats, values };
}

describe("weekBoundaries", () => {
  it("starts each week on Monday at local midnight, ending after the current week", () => {
    const bounds = weekBoundaries(at(14, 12), 3);
    expect(bounds).toEqual([new Date(2026, 8, 28), new Date(2026, 9, 5), new Date(2026, 9, 12), new Date(2026, 9, 19)]);
    expect(bounds.every((d) => d.getDay() === 1 && d.getHours() === 0)).toBe(true);
  });

  it("puts a Sunday night in the week that ends, and Monday midnight in the one that starts", () => {
    expect(weekBoundaries(at(18, 23), 1)).toEqual([new Date(2026, 9, 12), new Date(2026, 9, 19)]);
    expect(weekBoundaries(at(19, 0), 1)).toEqual([new Date(2026, 9, 19), new Date(2026, 9, 26)]);
  });
});

describe("stats.weekly", () => {
  it("returns the period's buckets, the previous period's start and every fixed series, zeroed on an empty board", () => {
    const { stats } = setup();
    const res = stats(4);
    expect(res.buckets).toHaveLength(4);
    expect(res.buckets[0]!.start).toBe(new Date(2026, 8, 21).toISOString());
    expect(res.buckets.at(-1)).toEqual({
      start: new Date(2026, 9, 12).toISOString(),
      end: new Date(2026, 9, 19).toISOString(),
    });
    expect(res.from).toBe(res.buckets[0]!.start);
    expect(res.to).toBe(res.buckets.at(-1)!.end);
    expect(res.previousFrom).toBe(new Date(2026, 7, 24).toISOString());
    expect(res.project).toBeNull();
    expect(res.series.tasks_created).toEqual({ unit: "count", values: [0, 0, 0, 0], total: 0, previousTotal: 0 });
    expect(res.series["cycle_time.created_to_done"]).toEqual({
      unit: "ms",
      values: [null, null, null, null],
      total: null,
      previousTotal: null,
    });
    expect(Object.keys(res.series)).toEqual(expect.arrayContaining(["prs_merged", "autopilot.cost_usd"]));
    expect(stats(52).buckets).toHaveLength(52);
  });

  it("counts tasks created and finished in the week they happened, with the previous period's total beside", () => {
    const { alpha, clock, task, finish, values } = setup();
    clock(at(1, 9, 8)); // 2026-09-01, in the previous period
    const old = task(alpha.id, "Old");
    finish(old.id);
    clock(at(11, 22)); // Sunday night: the week before the current one
    const sunday = task(alpha.id, "Sunday");
    clock(at(12, 0)); // Monday midnight: the current week
    const monday = task(alpha.id, "Monday");
    clock(at(13, 9));
    finish(monday.id);
    finish(sunday.id);
    clock(at(14, 12));

    expect(values("tasks_created")).toEqual({ unit: "count", values: [0, 0, 1, 1], total: 2, previousTotal: 1 });
    expect(values("tasks_completed")).toEqual({ unit: "count", values: [0, 0, 0, 2], total: 2, previousTotal: 1 });
  });

  it("leaves epics, closed duplicates and won't-dos out of throughput", () => {
    const { s, alpha, clock, task, finish, values } = setup();
    clock(at(12, 9));
    const epic = s.tasks.create({ projectId: alpha.id, title: "Epic", kind: "epic" });
    const child = s.tasks.create({ projectId: alpha.id, title: "Child", plan, epicId: epic.id });
    const dup = task(alpha.id, "Dup");
    const real = task(alpha.id, "Real");
    clock(at(13, 9));
    finish(child.id);
    s.tasks.close(dup.id, { resolution: "wont_do" }, "agent");
    finish(real.id);
    expect(values("tasks_created").total).toBe(3);
    expect(values("tasks_completed").total).toBe(2);
  });

  it("takes the median cycle time, from the first move to In Progress and from creation", () => {
    const { s, alpha, clock, task, finish, values } = setup();
    clock(at(12, 9));
    const slow = task(alpha.id, "Slow");
    const quick = task(alpha.id, "Quick");
    clock(at(12, 10));
    s.tasks.move(slow.id, { status: "in_progress" }, "agent");
    clock(at(12, 11));
    finish(quick.id);
    clock(at(12, 14));
    finish(slow.id);

    expect(values("cycle_time.in_progress_to_done")).toMatchObject({ unit: "ms", total: 4 * HOUR });
    expect(values("cycle_time.in_progress_to_done").values).toEqual([null, null, null, 4 * HOUR]);
    // Five hours and two: the median is their middle.
    expect(values("cycle_time.created_to_done").total).toBe(3.5 * HOUR);
  });

  it("counts review rounds, rounds per finished task and findings by severity", () => {
    const { s, alpha, clock, task, finish, values } = setup();
    clock(at(12, 9));
    const t = task(alpha.id, "Reviewed");
    const untouched = task(alpha.id, "Untouched");
    s.tasks.move(t.id, { status: "review" }, "agent");
    s.reviews.openRound(t.id, { trigger: "manual", actor: "agent" });
    s.reviews.submit(
      t.id,
      {
        findings: [
          { severity: "major", title: "a" },
          { severity: "major", title: "b" },
          { severity: "nit", title: "c" },
        ],
      },
      "reviewer",
    );
    clock(at(13, 9));
    finish(t.id);
    finish(untouched.id);

    expect(values("review_rounds").total).toBe(1);
    expect(values("review_findings.major")).toMatchObject({ total: 2, values: [0, 0, 0, 2] });
    expect(values("review_findings.nit").total).toBe(1);
    expect(values("review_findings.blocking").total).toBe(0);
    // One finished task had a round and one had none.
    expect(values("review_rounds_per_task")).toMatchObject({ unit: "ratio", total: 0.5 });
  });

  it("counts PRs merged by when the merge was seen, once per PR", () => {
    const { db, s, alpha, beta, clock, task, values } = setup();
    const repos = createRepos(db);
    const a = task(alpha.id, "A");
    const b = task(beta.id, "B");
    const merged = (taskId: string, url: string, when: Date) => {
      const link = s.links.add(taskId, { value: url, kind: "pr" }, "agent");
      repos.links.setPrChanges(link.id, { merged: when.toISOString() });
    };
    merged(a.id, "https://github.com/acme/app/pull/1", at(13, 10));
    merged(b.id, "https://github.com/acme/app/pull/2", at(8, 10)); // the week before
    merged(b.id, "https://github.com/acme/app/pull/3", at(1, 10, 8)); // the previous period
    // The same PR on a second task is one PR.
    merged(b.id, "https://github.com/acme/app/pull/1", at(13, 10));
    clock(at(14, 12));

    expect(values("prs_merged")).toEqual({ unit: "count", values: [0, 0, 1, 1], total: 2, previousTotal: 1 });
    expect(values("prs_merged", 4, alpha.id).total).toBe(1);
    // Beta has the PR it shares with alpha as well as its own.
    expect(values("prs_merged", 4, beta.id).total).toBe(2);
  });

  it("counts agent sessions once each, by when they were first linked", () => {
    const { s, alpha, clock, task, values } = setup();
    const a = task(alpha.id, "A");
    const b = task(alpha.id, "B");
    const session = (sessionId: string) => ({
      agentSession: { harness: "claude-code" as const, sessionId, cwd: "/w" },
    });
    const one = "709f26ed-ce2f-4449-b7eb-3bb01f89f268";
    const two = "809f26ed-ce2f-4449-b7eb-3bb01f89f268";
    clock(at(8, 9));
    s.links.add(a.id, session(one), "claude-code");
    clock(at(13, 9));
    s.links.add(b.id, session(one), "claude-code");
    s.links.add(b.id, session(two), "claude-code");

    expect(values("agent_sessions_started")).toMatchObject({ values: [0, 0, 1, 1], total: 2 });
  });

  it("counts Autopilot runs per automation and status, retries and cost", () => {
    const { s, alpha, clock, task, values } = setup();
    const t = task(alpha.id, "Work");
    clock(at(13, 9));
    const run = (key: string, status: "succeeded" | "failed", costUsd?: number) => {
      const recorded = s.autopilot.record({
        automation: "auto_archive",
        candidate: { dedupeKey: key, summary: "do it", projectId: alpha.id, taskId: t.id },
        dryRun: false,
      })!;
      s.autopilot.start(recorded.id);
      s.autopilot.finish(recorded.id, { status, ...(costUsd ? { costUsd } : {}) });
    };
    run("1", "failed", 0.25);
    run("2", "succeeded", 0.5);
    run("3", "succeeded");

    expect(values("autopilot.runs")).toMatchObject({ values: [0, 0, 0, 3], total: 3 });
    expect(values("autopilot.runs.auto_archive.succeeded").total).toBe(2);
    expect(values("autopilot.runs.auto_archive.failed").total).toBe(1);
    // Only the run right after the failed one retries it.
    expect(values("autopilot.retries").total).toBe(1);
    expect(values("autopilot.cost_usd")).toMatchObject({ unit: "usd", total: 0.75 });
  });

  it("limits everything to one project when asked, and rejects an unknown one", () => {
    const { s, alpha, beta, clock, task, finish, stats, values } = setup();
    clock(at(12, 9));
    const a = task(alpha.id, "In alpha");
    task(beta.id, "In beta");
    finish(a.id);

    expect(values("tasks_created").total).toBe(2);
    expect(values("tasks_created", 4, alpha.id).total).toBe(1);
    expect(values("tasks_completed", 4, beta.id).total).toBe(0);
    expect(stats(4, alpha.id).project).toEqual({ id: alpha.id, title: "Alpha" });
    expect(() => s.stats.weekly(4, "nope")).toThrow(/not found/i);
  });
});
