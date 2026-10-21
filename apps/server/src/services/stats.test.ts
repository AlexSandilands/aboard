import { UNSTICK_STALE_PREFIX } from "@repo/contracts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepos } from "../db/repos/index.ts";
import { defaultRunGit, type RunGit } from "../integrations/backup.ts";
import { git } from "../test/gitRepo.ts";
import { createTestHarness } from "../test/harness.ts";
import { dayBoundaries, weekBoundaries } from "./stats.ts";

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
  const stats = (weeks: 1 | 4 | 12 | 52 = 4, projectId?: string) =>
    s.stats.weekly(weeks, projectId ? [projectId] : undefined);
  const values = async (name: string, weeks: 1 | 4 | 12 | 52 = 4, projectId?: string) =>
    (await stats(weeks, projectId)).series[name]!;
  return { ...h, s, alpha, beta, clock, task, finish, stats, values };
}

describe("weekBoundaries", () => {
  it("starts each week on Monday at local midnight, ending after the current week", () => {
    const bounds = weekBoundaries(at(14, 12), 3);
    expect(bounds).toEqual([new Date(2026, 8, 28), new Date(2026, 9, 5), new Date(2026, 9, 12), new Date(2026, 9, 19)]);
    expect(bounds.every((d) => d.getDay() === 1 && d.getHours() === 0)).toBe(true);
  });

  it("starts every week at midnight across a clock change", () => {
    const zone = process.env.TZ;
    try {
      // New York puts its clocks forward on 2026-03-08 and back on 2026-11-01.
      process.env.TZ = "America/New_York";
      const bounds = weekBoundaries(new Date(2026, 10, 18, 12), 52);
      expect(bounds.some((d) => d.getTimezoneOffset() !== bounds[0]!.getTimezoneOffset())).toBe(true);
      expect(bounds.every((d) => d.getDay() === 1 && d.getHours() === 0)).toBe(true);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("puts a Sunday night in the week that ends, and Monday midnight in the one that starts", () => {
    expect(weekBoundaries(at(18, 23), 1)).toEqual([new Date(2026, 9, 12), new Date(2026, 9, 19)]);
    expect(weekBoundaries(at(19, 0), 1)).toEqual([new Date(2026, 9, 19), new Date(2026, 9, 26)]);
  });
});

describe("dayBoundaries", () => {
  it("starts each day at local midnight, ending after today", () => {
    const bounds = dayBoundaries(at(14, 12), 3);
    expect(bounds).toEqual([
      new Date(2026, 9, 12),
      new Date(2026, 9, 13),
      new Date(2026, 9, 14),
      new Date(2026, 9, 15),
    ]);
  });

  it("starts every day at midnight across a clock change", () => {
    const zone = process.env.TZ;
    try {
      // New York puts its clocks back on 2026-11-01, so that day has 25 hours.
      process.env.TZ = "America/New_York";
      const bounds = dayBoundaries(new Date(2026, 10, 3, 12), 14);
      expect(bounds.some((d) => d.getTimezoneOffset() !== bounds[0]!.getTimezoneOffset())).toBe(true);
      expect(bounds.every((d) => d.getHours() === 0)).toBe(true);
      expect(bounds.map((d) => d.getDate())).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 1, 2, 3, 4]);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("stats.weekly", () => {
  it("returns the period's buckets, the previous period's start and every fixed series, zeroed on an empty board", async () => {
    const { stats } = setup();
    const res = await stats(4);
    expect(res.buckets).toHaveLength(4);
    expect(res.buckets[0]!.start).toBe(new Date(2026, 8, 21).toISOString());
    expect(res.buckets.at(-1)).toEqual({
      start: new Date(2026, 9, 12).toISOString(),
      end: new Date(2026, 9, 19).toISOString(),
    });
    expect(res.from).toBe(res.buckets[0]!.start);
    expect(res.to).toBe(res.buckets.at(-1)!.end);
    expect(res.previousFrom).toBe(new Date(2026, 7, 24).toISOString());
    expect(res.projects).toEqual([]);
    expect(res.series.tasks_created).toEqual({ unit: "count", values: [0, 0, 0, 0], total: 0, previousTotal: 0 });
    expect(res.series["cycle_time.created_to_done"]).toEqual({
      unit: "ms",
      values: [null, null, null, null],
      total: null,
      previousTotal: null,
    });
    expect(Object.keys(res.series)).toEqual(expect.arrayContaining(["prs_merged", "autopilot.cost_usd"]));
    expect((await stats(52)).buckets).toHaveLength(52);
  });

  it("counts tasks created and finished in the week they happened, with the previous period's total beside", async () => {
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

    expect(await values("tasks_created")).toEqual({ unit: "count", values: [0, 0, 1, 1], total: 2, previousTotal: 1 });
    expect(await values("tasks_completed")).toEqual({
      unit: "count",
      values: [0, 0, 0, 2],
      total: 2,
      previousTotal: 1,
    });
  });

  it("shows one week by day: the last 7 days ending today, against the 7 before", async () => {
    const { alpha, clock, task, finish, stats, values } = setup();
    clock(at(1, 9, 8)); // 2026-09-01, before both periods
    finish(task(alpha.id, "Old").id);
    clock(at(5, 10)); // Monday the 5th, the first day of the previous period
    finish(task(alpha.id, "Previous").id);
    clock(at(8, 10)); // Thursday the 8th, the last 7 days start on the 8th
    finish(task(alpha.id, "First day").id);
    clock(at(14, 9)); // today
    finish(task(alpha.id, "Today a").id);
    finish(task(alpha.id, "Today b").id);
    clock(at(14, 12));

    const week = await stats(1);
    expect(week.bucket).toBe("day");
    expect(week.weeks).toBe(1);
    expect(week.buckets).toHaveLength(7);
    expect(week.buckets[0]).toEqual({
      start: new Date(2026, 9, 8).toISOString(),
      end: new Date(2026, 9, 9).toISOString(),
    });
    expect(week.buckets[6]).toEqual({
      start: new Date(2026, 9, 14).toISOString(),
      end: new Date(2026, 9, 15).toISOString(),
    });
    expect(week.previousFrom).toBe(new Date(2026, 9, 1).toISOString());
    expect(await values("tasks_completed", 1)).toEqual({
      unit: "count",
      values: [1, 0, 0, 0, 0, 0, 2],
      total: 3,
      previousTotal: 1,
    });
    expect((await stats(4)).bucket).toBe("week");
  });

  it("leaves epics, closed duplicates and won't-dos out of throughput", async () => {
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
    expect((await values("tasks_created")).total).toBe(3);
    expect((await values("tasks_completed")).total).toBe(2);
  });

  it("takes the median cycle time, from the first move to In Progress and from creation", async () => {
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

    expect(await values("cycle_time.in_progress_to_done")).toMatchObject({ unit: "ms", total: 4 * HOUR });
    expect((await values("cycle_time.in_progress_to_done")).values).toEqual([null, null, null, 4 * HOUR]);
    // Five hours and two: the median is their middle.
    expect((await values("cycle_time.created_to_done")).total).toBe(3.5 * HOUR);
  });

  it("measures a reopened task's cycle time from its last start", async () => {
    const { s, alpha, clock, task, finish, values } = setup();
    clock(at(12, 9));
    const t = task(alpha.id, "Reopened");
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    clock(at(12, 10));
    finish(t.id);
    clock(at(13, 9));
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    clock(at(13, 12));
    finish(t.id);

    expect((await values("tasks_completed")).total).toBe(1);
    expect((await values("cycle_time.in_progress_to_done")).total).toBe(3 * HOUR);
  });

  it("counts review rounds, rounds per finished task and findings by severity", async () => {
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

    expect((await values("review_rounds")).total).toBe(1);
    expect(await values("review_findings.major")).toMatchObject({ total: 2, values: [0, 0, 0, 2] });
    expect((await values("review_findings.nit")).total).toBe(1);
    expect((await values("review_findings.blocking")).total).toBe(0);
    // One finished task had a round and one had none.
    expect(await values("review_rounds_per_task")).toMatchObject({ unit: "ratio", total: 0.5 });
  });

  it("counts PRs merged by when the merge was seen, once per PR", async () => {
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

    expect(await values("prs_merged")).toEqual({ unit: "count", values: [0, 0, 1, 1], total: 2, previousTotal: 1 });
    expect((await values("prs_merged", 4, alpha.id)).total).toBe(1);
    // Beta has the PR it shares with alpha as well as its own.
    expect((await values("prs_merged", 4, beta.id)).total).toBe(2);
  });

  it("counts agent sessions once each, by when they were first linked", async () => {
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

    expect(await values("agent_sessions_started")).toMatchObject({ values: [0, 0, 1, 1], total: 2 });
  });

  it("counts Autopilot runs per automation and status, retries and cost", async () => {
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
    // Runs are ordered by when they finished, and a tie falls to a random id, so each gets its own minute.
    run("1", "failed", 0.25);
    clock(at(13, 10));
    run("2", "succeeded", 0.5);
    clock(at(13, 11));
    run("3", "succeeded");

    expect(await values("autopilot.runs")).toMatchObject({ values: [0, 0, 0, 3], total: 3 });
    expect((await values("autopilot.runs.auto_archive.succeeded")).total).toBe(2);
    expect((await values("autopilot.runs.auto_archive.failed")).total).toBe(1);
    // Only the run right after the failed one retries it.
    expect((await values("autopilot.retries")).total).toBe(1);
    expect(await values("autopilot.cost_usd")).toMatchObject({ unit: "usd", total: 0.75 });
  });

  it("counts blocked and skipped steps, and attention requests, in the week they happened", async () => {
    const { s, alpha, beta, clock, values } = setup();
    const withSteps = (projectId: string, n: number) =>
      s.tasks.create({
        projectId,
        title: "Steps",
        plan: { phases: [{ title: "Build", steps: Array.from({ length: n }, (_, i) => ({ title: `s${i}` })) }] },
      });
    const stepsOf = (task: { phases: { steps: { id: string }[] }[] }) => task.phases.flatMap((p) => p.steps);
    const a = withSteps(alpha.id, 3);
    const b = withSteps(beta.id, 1);
    const [one, two, three] = stepsOf(a);
    clock(at(8, 9));
    s.plans.updateStep(one!.id, { status: "blocked" }, "agent");
    clock(at(13, 9));
    s.plans.updateStep(two!.id, { status: "skipped" }, "agent");
    s.plans.updateStep(three!.id, { status: "blocked" }, "agent");
    // A note on a step, or the same status again, isn't a new mark.
    s.plans.updateStep(three!.id, { notes: "waiting on the user" }, "agent");
    s.plans.updateStep(stepsOf(b)[0]!.id, { status: "blocked" }, "agent");
    s.attention.request(a.id, "Need a decision", "agent");
    clock(at(14, 9));
    s.attention.request(b.id, "Look at this", "agent");

    expect(await values("friction.steps_blocked")).toMatchObject({ values: [0, 0, 1, 2], total: 3, previousTotal: 0 });
    expect(await values("friction.steps_skipped")).toMatchObject({ values: [0, 0, 0, 1], total: 1 });
    expect(await values("friction.attention_requests")).toMatchObject({ values: [0, 0, 0, 2], total: 2 });
    expect((await values("friction.steps_blocked", 4, alpha.id)).total).toBe(2);
    expect((await values("friction.attention_requests", 4, beta.id)).total).toBe(1);
  });

  it("counts flags, stalls and runs cut short by a restart, naming a stall once per task, kind and week", async () => {
    const { s, alpha, beta, clock, task, values } = setup();
    const t = task(alpha.id, "Work");
    const other = task(beta.id, "Other");
    let n = 0;
    const run = (automation: string, taskId: string, projectId: string, result: object, hour = 9, day = 13) => {
      clock(at(day, hour));
      const recorded = s.autopilot.record({
        automation,
        candidate: { dedupeKey: String(n++), summary: "run", projectId, taskId },
        dryRun: false,
      })!;
      s.autopilot.start(recorded.id);
      s.autopilot.finish(recorded.id, result);
    };
    // The same task found stale twice in a week is one stall; found waiting too, a second kind.
    run("unstick", t.id, alpha.id, { summary: `${UNSTICK_STALE_PREFIX} 26h` }, 9, 8);
    run("unstick", t.id, alpha.id, { summary: `${UNSTICK_STALE_PREFIX} 30h` }, 9);
    run("unstick", t.id, alpha.id, { summary: `${UNSTICK_STALE_PREFIX} 31h` }, 10);
    run("unstick", t.id, alpha.id, { summary: "Waiting on input" }, 11);
    // A run that failed isn't a stall, and flagging is separate from failing.
    run("unstick", other.id, beta.id, { status: "failed", error: "boom", needsAttention: true }, 12);
    run("auto_archive", t.id, alpha.id, { needsAttention: true }, 13);
    // The inbox's thread-waiting notices count too, once per task and week, even when Unstick found the same.
    clock(at(14, 9));
    s.notifications.notify({
      kind: "thread_waiting",
      taskId: t.id,
      title: "Waiting",
      body: "Waiting",
      dedupeKey: "w1",
    });
    s.notifications.notify({
      kind: "thread_waiting",
      taskId: other.id,
      title: "Waiting",
      body: "Waiting",
      dedupeKey: "w2",
    });
    // A run still going when the board restarted: recover() flags it too, but it counts as a restart only.
    clock(at(14, 10));
    const stranded = s.autopilot.record({
      automation: "auto_archive",
      candidate: { dedupeKey: "stranded", summary: "run", projectId: alpha.id, taskId: t.id },
      dryRun: false,
    })!;
    s.autopilot.start(stranded.id);
    clock(at(14, 11));
    expect(s.autopilot.recover()).toBe(1);

    expect(await values("friction.stalls.stale")).toMatchObject({ values: [0, 0, 1, 1], total: 2 });
    expect(await values("friction.stalls.waiting")).toMatchObject({ values: [0, 0, 0, 2], total: 2 });
    expect(await values("friction.autopilot_flags")).toMatchObject({ values: [0, 0, 0, 2], total: 2 });
    expect(await values("friction.runs_restarted")).toMatchObject({ values: [0, 0, 0, 1], total: 1 });
    expect((await values("friction.stalls.waiting", 4, beta.id)).total).toBe(1);
    expect((await values("friction.autopilot_flags", 4, beta.id)).total).toBe(1);
    expect((await values("friction.runs_restarted", 4, beta.id)).total).toBe(0);
  });

  it("splits finished tasks by label and suggested tier, and sessions by harness, with the previous period beside", async () => {
    const { s, alpha, beta, clock, finish, stats } = setup();
    const make = (projectId: string, labels: string[], tier?: "light" | "deep") =>
      s.tasks.create({
        projectId,
        title: "T",
        plan: { ...plan, ...(tier ? { suggestedModel: { tier } } : {}) },
        labels,
      });
    // Last period, then this one.
    clock(at(10, 9, 8));
    finish(make(alpha.id, ["ui"], "light").id);
    clock(at(13, 9));
    finish(make(alpha.id, ["ui", "backend"], "deep").id);
    finish(make(alpha.id, ["backend"], "deep").id);
    finish(make(beta.id, []).id);
    // Not finished, so not counted.
    make(alpha.id, ["ui"], "light");
    const linkTask = make(alpha.id, []);
    const session = (harness: "claude-code" | "copilot-cli", sessionId: string) => ({
      agentSession: { harness, sessionId, cwd: "/w" },
    });
    s.links.add(linkTask.id, session("claude-code", "709f26ed-ce2f-4449-b7eb-3bb01f89f268"), "agent");
    s.links.add(linkTask.id, session("claude-code", "709f26ed-ce2f-4449-b7eb-3bb01f89f268"), "agent");
    s.links.add(linkTask.id, session("copilot-cli", "copilot-1"), "agent");
    s.links.add(linkTask.id, { t3Thread: { environmentId: "env", threadId: "th-1" } }, "agent");
    s.links.add(linkTask.id, { t3Thread: { environmentId: "env", threadId: "th-1" } }, "agent");

    // The same sessions are behind the weekly series and the breakdown, less the T3 thread.
    expect((await stats(4)).series.agent_sessions_started!.total).toBe(2);

    const { breakdowns } = await stats(4);
    expect(breakdowns.completed_by_label).toEqual({
      unit: "count",
      items: [
        { key: "backend", total: 2, previousTotal: 0 },
        { key: "ui", total: 1, previousTotal: 1 },
        { key: null, total: 1, previousTotal: 0 },
      ],
    });
    expect(breakdowns.completed_by_tier!.items).toEqual([
      { key: "deep", total: 2, previousTotal: 0 },
      { key: null, total: 1, previousTotal: 0 },
      { key: "light", total: 0, previousTotal: 1 },
    ]);
    expect(breakdowns.sessions_by_harness!.items).toEqual([
      { key: "claude-code", total: 1, previousTotal: 0 },
      { key: "copilot-cli", total: 1, previousTotal: 0 },
      { key: "t3_thread", total: 1, previousTotal: 0 },
    ]);
    expect((await stats(4, beta.id)).breakdowns.completed_by_label!.items).toEqual([
      { key: null, total: 1, previousTotal: 0 },
    ]);
    expect((await stats(4, beta.id)).breakdowns.sessions_by_harness!.items).toEqual([]);
  });

  it("averages and takes the median of the time spent in each status, in the week the stay ended", async () => {
    const { s, alpha, clock, task, finish, values } = setup();
    clock(at(12, 9));
    const a = task(alpha.id, "A");
    const b = task(alpha.id, "B");
    clock(at(12, 10));
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    clock(at(12, 11));
    s.tasks.move(b.id, { status: "in_progress" }, "agent");
    clock(at(12, 13));
    s.tasks.move(a.id, { status: "review" }, "agent");
    clock(at(12, 14));
    finish(a.id);

    // A waited one hour in Planned and B two; the stays ended in this week.
    expect(await values("time_in_status.planned.average")).toEqual({
      unit: "ms",
      values: [null, null, null, 1.5 * HOUR],
      total: 1.5 * HOUR,
      previousTotal: null,
    });
    expect((await values("time_in_status.planned.median")).total).toBe(1.5 * HOUR);
    expect((await values("time_in_status.in_progress.median")).total).toBe(3 * HOUR);
    expect((await values("time_in_status.review.average")).total).toBe(HOUR);
    // B is still in progress and nothing has left Backlog: neither has a finished stay.
    expect((await values("time_in_status.backlog.average")).total).toBeNull();
  });

  it("uses the median, not the mean, for the median series", async () => {
    const { s, alpha, clock, task, values } = setup();
    clock(at(12, 9));
    const ids = [task(alpha.id, "A"), task(alpha.id, "B"), task(alpha.id, "C")].map((t) => t.id);
    // Stays of 1h, 2h and 9h in Planned.
    for (const [i, hours] of [1, 2, 9].entries()) {
      clock(at(12, 9 + hours));
      s.tasks.move(ids[i]!, { status: "in_progress" }, "agent");
    }
    expect((await values("time_in_status.planned.median")).total).toBe(2 * HOUR);
    expect((await values("time_in_status.planned.average")).total).toBe(4 * HOUR);
  });

  it("counts the open tasks in each status as of every week's end, and as of now for the current week", async () => {
    const { s, alpha, clock, task, values } = setup();
    clock(at(5, 9));
    task(alpha.id, "A");
    const b = task(alpha.id, "B");
    const done = task(alpha.id, "Done");
    const archived = task(alpha.id, "Archived");
    s.tasks.create({ projectId: alpha.id, title: "Epic", kind: "epic" });
    clock(at(6, 9));
    s.tasks.move(done.id, { status: "done" }, "agent");
    clock(at(7, 9));
    s.tasks.move(b.id, { status: "in_progress" }, "agent");
    clock(at(13, 9));
    s.tasks.update(archived.id, { archived: true }, "user");
    task(alpha.id, "C");
    clock(at(14, 12));

    // As of Sep 28, Oct 5 (nothing yet), Oct 12 (the archived one still open) and now (Wed Oct 14).
    expect(await values("open_tasks.planned")).toEqual({
      unit: "count",
      values: [0, 0, 2, 2],
      total: 2,
      previousTotal: 0,
    });
    expect(await values("open_tasks.in_progress")).toMatchObject({ values: [0, 0, 1, 1], total: 1 });
    expect((await values("open_tasks.review")).values).toEqual([0, 0, 0, 0]);
  });

  it("compares the open tasks with where the previous period ended", async () => {
    const { clock, task, alpha, values } = setup();
    clock(at(1, 9, 8)); // 2026-09-01, before the 4 weeks shown and inside the 4 before them
    task(alpha.id, "Old");
    clock(at(14, 12));
    expect(await values("open_tasks.planned")).toMatchObject({ total: 1, previousTotal: 1 });
  });

  it("takes how long merged PRs were open, and Autopilot's rounds and attempts on them", async () => {
    const { db, s, alpha, clock, task, values } = setup();
    const repos = createRepos(db);
    const t = task(alpha.id, "Work");
    const link = (url: string, linked: Date, merged: Date) => {
      clock(linked);
      const l = s.links.add(t.id, { value: url, kind: "pr" }, "agent");
      repos.links.setPrChanges(l.id, { merged: merged.toISOString() });
      return l;
    };
    const first = link("https://github.com/acme/app/pull/1", at(8, 10), at(13, 10));
    link("https://github.com/acme/app/pull/2", at(13, 8), at(13, 10));
    link("https://github.com/acme/app/pull/3", at(13, 9), at(13, 10));
    let minute = 0;
    const run = (
      automation: string,
      key: string,
      extra: { status?: "succeeded" | "skipped"; output?: Record<string, unknown> } = {},
    ) => {
      clock(new Date(2026, 9, 13, 12, ++minute));
      const recorded = s.autopilot.record({
        automation,
        candidate: { dedupeKey: key, summary: "do it", projectId: alpha.id, taskId: t.id },
        dryRun: false,
      })!;
      s.autopilot.start(recorded.id);
      s.autopilot.finish(recorded.id, {
        status: extra.status ?? "succeeded",
        ...(extra.output ? { output: extra.output } : {}),
      });
    };
    const review = (round: number, handoff: "fix" | "gave_up") => ({
      kind: "pr_review",
      linkId: first.id,
      prUrl: first.url,
      headOid: "h",
      round,
      maxRounds: 2,
      reviewUrl: "r",
      reviewId: null,
      counts: { blocking: 0, major: 1, minor: 0, nit: 0 },
      fyi: 0,
      threshold: "minor",
      actionable: 1,
      handoff,
    });
    run("review_prs", `review:pr:${first.id}:a`, { output: review(1, "fix") });
    run("review_prs", `review:pr:${first.id}:b`, { output: review(2, "gave_up") });
    run("fix_prs", `fix:pr:${first.id}:a:checks@a`);
    run("fix_prs", `fix:pr:${first.id}:b:conflict@b`); // conflict-only attempts count too
    run("fix_prs", `fix:pr:${first.id}:c:checks@c`, { status: "skipped" }); // did nothing
    run("fix_prs", `fix:gave_up:${first.id}`);
    clock(at(14, 12));

    // Open for five days, two hours and one hour: the median is the middle one.
    expect(await values("pr_open_to_merged")).toEqual({
      unit: "ms",
      values: [null, null, null, 2 * HOUR],
      total: 2 * HOUR,
      previousTotal: null,
    });
    // Three PRs: the first went two review rounds and two fix attempts, the others none.
    expect(await values("autopilot.pr_review_rounds_per_pr")).toMatchObject({ unit: "ratio", total: 2 / 3 });
    expect(await values("autopilot.fix_attempts_per_pr")).toMatchObject({ unit: "ratio", total: 2 / 3 });
    expect(await values("autopilot.gave_up")).toMatchObject({ values: [0, 0, 0, 2], total: 2 });
    expect((await values("autopilot.gave_up.review_prs")).total).toBe(1);
    expect((await values("autopilot.gave_up.fix_prs")).total).toBe(1);
  });

  it("counts a PR linked to two tasks once, open from its first link, with Autopilot's work on both", async () => {
    const { db, s, alpha, clock, task, values } = setup();
    const repos = createRepos(db);
    const url = "https://github.com/acme/app/pull/9";
    const [a, b] = [task(alpha.id, "A"), task(alpha.id, "B")];
    clock(at(8, 10));
    const first = s.links.add(a.id, { value: url, kind: "pr" }, "agent");
    clock(at(12, 10));
    const second = s.links.add(b.id, { value: url, kind: "pr" }, "agent");
    for (const l of [first, second]) repos.links.setPrChanges(l.id, { merged: at(13, 10).toISOString() });
    let minute = 0;
    const run = (taskId: string, automation: string, key: string, output?: Record<string, unknown>) => {
      clock(new Date(2026, 9, 13, 12, ++minute));
      const recorded = s.autopilot.record({
        automation,
        candidate: { dedupeKey: key, summary: "do it", projectId: alpha.id, taskId },
        dryRun: false,
      })!;
      s.autopilot.start(recorded.id);
      s.autopilot.finish(recorded.id, { status: "succeeded", ...(output ? { output } : {}) });
    };
    const review = (linkId: string, round: number) => ({
      kind: "pr_review",
      linkId,
      prUrl: url,
      headOid: "h",
      round,
      maxRounds: 3,
      reviewUrl: "r",
      reviewId: null,
      counts: { blocking: 0, major: 0, minor: 0, nit: 0 },
      fyi: 0,
      threshold: "minor",
      actionable: 0,
      handoff: "clean",
    });
    run(a.id, "review_prs", `review:pr:${first.id}:a`, review(first.id, 1));
    run(a.id, "review_prs", `review:pr:${first.id}:b`, review(first.id, 2));
    run(b.id, "review_prs", `review:pr:${second.id}:a`, review(second.id, 1));
    run(a.id, "fix_prs", `fix:pr:${first.id}:a:checks@a`);
    run(b.id, "fix_prs", `fix:pr:${second.id}:a:checks@a`);
    clock(at(14, 12));

    expect((await values("prs_merged")).total).toBe(1);
    // Open from the first link (Oct 8 10:00) to the merge (Oct 13 10:00).
    expect((await values("pr_open_to_merged")).total).toBe(5 * 24 * HOUR);
    // Two reviews of one link and one of the other; one fix attempt on each.
    expect((await values("autopilot.pr_review_rounds_per_pr")).total).toBe(3);
    expect((await values("autopilot.fix_attempts_per_pr")).total).toBe(2);
  });

  it("limits the flow series to one project", async () => {
    const { clock, task, alpha, beta, s, values } = setup();
    clock(at(12, 9));
    const a = task(alpha.id, "A");
    task(beta.id, "B");
    clock(at(12, 11));
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    clock(at(14, 12));

    expect((await values("time_in_status.planned.average", 4, alpha.id)).total).toBe(2 * HOUR);
    expect((await values("time_in_status.planned.average", 4, beta.id)).total).toBeNull();
    expect((await values("open_tasks.planned", 4, beta.id)).total).toBe(1);
    expect((await values("open_tasks.planned")).total).toBe(1);
  });

  it("limits everything to one project when asked, and rejects an unknown one", async () => {
    const { s, alpha, beta, clock, task, finish, stats, values } = setup();
    clock(at(12, 9));
    const a = task(alpha.id, "In alpha");
    task(beta.id, "In beta");
    finish(a.id);

    expect((await values("tasks_created")).total).toBe(2);
    expect((await values("tasks_created", 4, alpha.id)).total).toBe(1);
    expect((await values("tasks_completed", 4, beta.id)).total).toBe(0);
    expect((await stats(4, alpha.id)).projects).toEqual([{ id: alpha.id, title: "Alpha" }]);
    await expect(s.stats.weekly(4, ["nope"])).rejects.toThrow(/not found/i);
  });

  it("covers a subset of the projects, in the order asked for, and a 404 for any unknown one", async () => {
    const { s, alpha, beta, clock, task, finish } = setup();
    const gamma = s.projects.create({ title: "Gamma", workspaceRoot: "/work/gamma" });
    clock(at(12, 9));
    const a = task(alpha.id, "In alpha");
    const b = task(beta.id, "In beta");
    task(gamma.id, "In gamma");
    finish(a.id);
    finish(b.id);

    const both = await s.stats.weekly(4, [beta.id, alpha.id]);
    expect(both.projects).toEqual([
      { id: beta.id, title: "Beta" },
      { id: alpha.id, title: "Alpha" },
    ]);
    expect(both.series.tasks_created!.total).toBe(2);
    expect(both.series.tasks_completed!.total).toBe(2);
    expect(both.series["open_tasks.backlog"]!.total).toBe(0);
    expect((await s.stats.weekly(4)).series.tasks_created!.total).toBe(3);
    await expect(s.stats.weekly(4, [alpha.id, "nope"])).rejects.toThrow(/not found/i);
  });
});

describe("stats.weekly commits", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "stats-commits-"));
    dirs.push(dir);
    return dir;
  };
  const run = (cwd: string, env: Record<string, string>, ...args: string[]) => {
    Object.assign(process.env, env);
    try {
      return git(
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      );
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
    }
  };
  /** A repository on `main` with a commit at each time given (local times), the first of which is the root. */
  const repoWith = (...times: Date[]) => {
    const dir = tempDir();
    git(dir, "init", "--quiet", "-b", "main");
    times.forEach((when, i) => commit(dir, `c${i}.txt`, when));
    return dir;
  };
  const commit = (dir: string, file: string, when: Date) => {
    writeFileSync(join(dir, file), file);
    git(dir, "add", file);
    const stamp = { GIT_COMMITTER_DATE: when.toISOString(), GIT_AUTHOR_DATE: when.toISOString() };
    run(dir, stamp, "commit", "--quiet", "-m", file);
  };

  function setupCommits(options: { runGit?: RunGit } = {}) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(14, 12));
    const h = createTestHarness(options.runGit ? { integrations: { runGit: options.runGit } } : {});
    return { ...h, s: h.services };
  }

  it("counts commits on the default branch in the week they landed, leaving merges and older history out", async () => {
    const dir = repoWith(at(1, 9, 7), at(1, 9, 8)); // 2026-08-01 is before the two periods; 09-01 is in the previous one
    commit(dir, "late.txt", at(13, 10)); // current week
    git(dir, "checkout", "--quiet", "-b", "topic");
    commit(dir, "topic.txt", at(8, 10)); // the week before
    git(dir, "checkout", "--quiet", "main");
    run(
      dir,
      { GIT_COMMITTER_DATE: at(8, 11).toISOString() },
      "merge",
      "--quiet",
      "--no-ff",
      "topic",
      "-m",
      "merge topic",
    );
    git(dir, "checkout", "--quiet", "-b", "unmerged");
    commit(dir, "unmerged.txt", at(12, 10)); // on a branch that never landed
    git(dir, "checkout", "--quiet", "main");
    const { s } = setupCommits();
    s.projects.create({ title: "Alpha", workspaceRoot: dir });

    const res = await s.stats.weekly(4);
    expect(res.series.commits).toEqual({ unit: "count", values: [0, 0, 1, 1], total: 2, previousTotal: 1 });
    expect(res.notes).toEqual([]);
  });

  it("sums the projects, or reads just the one asked for, and skips a project without a folder", async () => {
    const one = repoWith(at(13, 10));
    const two = repoWith(at(13, 11), at(8, 11));
    const { s } = setupCommits();
    const alpha = s.projects.create({ title: "Alpha", workspaceRoot: one });
    s.projects.create({ title: "Beta", workspaceRoot: two });
    s.projects.create({ title: "Gamma" });
    const gamma = s.projects.list().find((p) => p.title === "Gamma")!;

    const all = await s.stats.weekly(4);
    expect(all.series.commits!.total).toBe(3);
    expect(all.notes).toEqual([]);
    expect((await s.stats.weekly(4, [alpha.id])).series.commits!.total).toBe(1);
    const none = await s.stats.weekly(4, [gamma.id]);
    expect(none.series.commits!.total).toBe(0);
    expect(none.notes).toEqual(["Gamma has no folder, so its commits aren't counted"]);
  });

  it("counts a repository's commits once when several projects point at it", async () => {
    const dir = repoWith(at(13, 10), at(8, 10));
    mkdirSync(join(dir, "sub"));
    const { s } = setupCommits();
    s.projects.create({ title: "Whole", workspaceRoot: dir });
    s.projects.create({ title: "Sub", workspaceRoot: join(dir, "sub") });

    expect((await s.stats.weekly(4)).series.commits!.total).toBe(2);
  });

  it("gives an empty series and a note for a folder that is missing or isn't a repository", async () => {
    const good = repoWith(at(13, 10));
    const plain = tempDir();
    const { s } = setupCommits();
    s.projects.create({ title: "Good", workspaceRoot: good });
    s.projects.create({ title: "Plain", workspaceRoot: plain });
    s.projects.create({ title: "Gone", workspaceRoot: join(plain, "missing") });

    const res = await s.stats.weekly(4);
    expect(res.series.commits!.total).toBe(1);
    expect(res.notes).toHaveLength(2);
    expect(res.notes.join("\n")).toMatch(/Plain weren't counted: .* isn't a git repository/);
    expect(res.notes.join("\n")).toMatch(/Gone weren't counted: the folder .* doesn't exist/);
  });

  it("gives a note when the repository has no default branch to read", async () => {
    const dir = tempDir();
    git(dir, "init", "--quiet", "-b", "trunk");
    commit(dir, "a.txt", at(13, 10));
    const { s } = setupCommits();
    s.projects.create({ title: "Trunk", workspaceRoot: dir });

    const res = await s.stats.weekly(4);
    expect(res.series.commits!.total).toBe(0);
    expect(res.notes[0]).toMatch(/Trunk weren't counted: can't tell .* default branch/);
  });

  it("reads origin's copy of the default branch when the checkout has one, else the local branch", async () => {
    const ahead = repoWith(at(8, 10), at(13, 10)); // the local main has a commit origin's doesn't
    git(ahead, "update-ref", "refs/remotes/origin/main", "HEAD~1");
    git(ahead, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const dangling = repoWith(at(8, 10), at(13, 10)); // origin's HEAD names a branch that isn't there
    git(dangling, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const { s } = setupCommits();
    const first = s.projects.create({ title: "Ahead", workspaceRoot: ahead });
    const second = s.projects.create({ title: "Dangling", workspaceRoot: dangling });

    expect((await s.stats.weekly(4, [first.id])).series.commits).toMatchObject({ values: [0, 0, 1, 0], total: 1 });
    const res = await s.stats.weekly(4, [second.id]);
    expect(res.series.commits!.total).toBe(2);
    expect(res.notes).toEqual([]);
  });

  it("asks again after thirty seconds when a read failed", async () => {
    const dir = tempDir();
    const { s } = setupCommits();
    const project = s.projects.create({ title: "Late", workspaceRoot: dir });
    expect((await s.stats.weekly(4, [project.id])).notes).toHaveLength(1);

    git(dir, "init", "--quiet", "-b", "main");
    commit(dir, "a.txt", at(13, 10));
    expect((await s.stats.weekly(4, [project.id])).notes).toHaveLength(1);
    vi.setSystemTime(new Date(at(14, 12).getTime() + 31_000));
    const res = await s.stats.weekly(4, [project.id]);
    expect(res.notes).toEqual([]);
    expect(res.series.commits!.total).toBe(1);
  });

  it("reads git once per project and period for ten minutes", async () => {
    const dir = repoWith(at(13, 10));
    const logs: string[][] = [];
    const { s } = setupCommits({
      runGit: (args, cwd) => {
        if (args[0] === "log") logs.push(args);
        return defaultRunGit(args, cwd);
      },
    });
    s.projects.create({ title: "Alpha", workspaceRoot: dir });

    await s.stats.weekly(4);
    await s.stats.weekly(4);
    expect(logs).toHaveLength(1);
    await s.stats.weekly(12);
    expect(logs).toHaveLength(2);
    vi.setSystemTime(new Date(at(14, 12).getTime() + 11 * 60_000));
    expect((await s.stats.weekly(4)).series.commits!.total).toBe(1);
    expect(logs).toHaveLength(3);
  });
});
