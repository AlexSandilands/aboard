import { AUTOPILOT_REVIEW_PRS, AUTOPILOT_UNSTICK } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_CAPS, renderActivity } from "../mcp/activityFormat.ts";
import { createTestHarness } from "../test/harness.ts";

// 2026-10-12 is a Monday.
const at = (day: number, hour = 9, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute));
const plan = {
  phases: [{ title: "Build", steps: [{ title: "a" }, { title: "b" }] }],
};

afterEach(() => vi.useRealTimers());

function setup() {
  // Only Date is ours: activity is stamped with it, and the clock is moved by hand.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(12, 8));
  const h = createTestHarness();
  const s = h.services;
  const alpha = s.projects.create({
    title: "Alpha",
    workspaceRoot: "/work/alpha",
  });
  const beta = s.projects.create({
    title: "Beta",
    workspaceRoot: "/work/beta",
  });
  const task = (projectId: string, title: string) => s.tasks.create({ projectId, title, plan });
  const clock = (when: Date) => vi.setSystemTime(when);
  const run = (input: {
    projectId: string;
    taskId?: string;
    key: string;
    automation?: string;
    status?: "succeeded" | "failed" | "skipped";
    summary?: string;
    error?: string;
    output?: Record<string, unknown>;
  }) => {
    const recorded = s.autopilot.record({
      automation: input.automation ?? "auto_archive",
      candidate: {
        dedupeKey: input.key,
        summary: input.summary ?? "do it",
        projectId: input.projectId,
        taskId: input.taskId ?? null,
      },
      dryRun: false,
    })!;
    s.autopilot.start(recorded.id);
    s.autopilot.finish(recorded.id, {
      status: input.status ?? "succeeded",
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.output ? { output: input.output } : {}),
    });
  };
  const week = () => s.activity.between(at(12, 0), at(19, 0));
  return { ...h, s, alpha, beta, task, clock, run, week };
}

describe("activity.between", () => {
  it("reports a finished task's time in each status, review rounds, and blocked or skipped steps", () => {
    const { s, alpha, task, clock, run, week } = setup();
    const t = task(alpha.id, "Add exports");
    clock(at(12, 10));
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    const [stepA, stepB] = s.tasks.detail(t.id).phases[0]!.steps;
    s.plans.updateStep(stepA!.id, { status: "blocked" }, "agent");
    s.plans.updateStep(stepB!.id, { status: "skipped" }, "agent");
    clock(at(12, 13));
    s.tasks.move(t.id, { status: "review" }, "agent");
    s.reviews.openRound(t.id, { trigger: "manual", actor: "agent" });
    clock(at(12, 14));
    s.tasks.move(t.id, { status: "done" }, "agent");
    run({
      projectId: alpha.id,
      taskId: t.id,
      key: "pr1",
      automation: AUTOPILOT_REVIEW_PRS,
      output: {
        kind: "pr_review",
        linkId: "l",
        prUrl: "u",
        headOid: "h",
        round: 2,
        maxRounds: 3,
        reviewUrl: "r",
        reviewId: 1,
        counts: { blocking: 0, major: 1, minor: 0, nit: 0 },
        fyi: 0,
        threshold: "minor",
        actionable: 1,
        handoff: "fix",
      },
    });

    const { finished } = week();
    expect(finished).toHaveLength(1);
    const [done] = finished;
    expect(done).toMatchObject({
      number: t.number,
      localRounds: 1,
      prRounds: 2,
      stepsBlocked: 1,
      stepsSkipped: 1,
      resolution: null,
    });
    const hour = 3_600_000;
    expect(done!.inStatus).toEqual({
      planned: 2 * hour,
      in_progress: 3 * hour,
      review: hour,
    });
    expect(renderActivity(week())).toContain(
      `#${t.number} Add exports — 2026-10-12 14:00 · Planned 2h, In Progress 3h, Review 1h · 1 local review round · 2 PR review rounds · 1 step blocked · 1 step skipped`,
    );
  });

  it("includes events at the start of the window and leaves out those at its end", () => {
    const { s, alpha, task, clock } = setup();
    const early = task(alpha.id, "Before");
    const first = task(alpha.id, "At start");
    const last = task(alpha.id, "At end");
    for (const t of [early, first, last]) s.tasks.move(t.id, { status: "in_progress" }, "agent");
    clock(at(11, 23, 59));
    s.tasks.move(early.id, { status: "done" }, "agent");
    clock(at(12, 0));
    s.tasks.move(first.id, { status: "done" }, "agent");
    clock(at(19, 0));
    s.tasks.move(last.id, { status: "done" }, "agent");

    expect(s.activity.between(at(12, 0), at(19, 0)).finished.map((t) => t.title)).toEqual(["At start"]);
  });

  it("counts a closed task, and leaves an epic out", () => {
    const { s, alpha, task, clock } = setup();
    const dup = task(alpha.id, "Duplicate");
    const epic = s.tasks.create({
      projectId: alpha.id,
      title: "Epic",
      kind: "epic",
    });
    const child = s.tasks.create({
      projectId: alpha.id,
      title: "Child",
      plan,
      epicId: epic.id,
    });
    clock(at(13));
    s.tasks.close(dup.id, { resolution: "wont_do" }, "agent");
    s.tasks.move(child.id, { status: "done" }, "agent");
    const { finished } = s.activity.between(at(12, 0), at(19, 0));
    expect(finished.map((t) => [t.title, t.resolution])).toEqual([
      ["Duplicate", "wont_do"],
      ["Child", null],
    ]);
  });

  it("limits everything to the project asked for", () => {
    const { s, alpha, beta, task, clock, run } = setup();
    const a = task(alpha.id, "In alpha");
    const b = task(beta.id, "In beta");
    clock(at(13));
    for (const t of [a, b]) {
      s.tasks.move(t.id, { status: "done" }, "agent");
      s.tasks.addNote(t.id, `note on ${t.title}`, "agent");
      s.reviews.submit(t.id, { findings: [{ severity: "major", title: `finding on ${t.title}` }] }, "reviewer");
    }
    run({
      projectId: alpha.id,
      taskId: a.id,
      key: "a",
      status: "failed",
      error: "alpha broke",
    });
    run({
      projectId: beta.id,
      taskId: b.id,
      key: "b",
      status: "failed",
      error: "beta broke",
    });

    const both = s.activity.between(at(12, 0), at(19, 0));
    expect(both.project).toBeNull();
    expect(both.finished).toHaveLength(2);
    expect(both.reviews.local).toHaveLength(2);
    expect(both.notes).toHaveLength(2);
    expect(both.runs[0]!.failed).toBe(2);

    const only = s.activity.between(at(12, 0), at(19, 0), alpha.id);
    expect(only.project).toEqual({ id: alpha.id, title: "Alpha" });
    expect(only.finished.map((t) => t.title)).toEqual(["In alpha"]);
    expect(only.reviews.local.map((f) => f.title)).toEqual(["finding on In alpha"]);
    expect(only.reviews.rounds.total).toBe(1);
    expect(only.notes.map((n) => n.title)).toEqual(["In alpha"]);
    expect(only.runs[0]!.failures.map((f) => f.reason)).toEqual(["alpha broke"]);
  });

  it("groups runs by automation with failures, board restarts, retries and give-ups", () => {
    const { s, alpha, task, clock, run, week } = setup();
    const t = task(alpha.id, "Flaky");
    clock(at(13));
    run({
      projectId: alpha.id,
      taskId: t.id,
      key: "1",
      status: "failed",
      error: "gh timed out",
    });
    run({ projectId: alpha.id, taskId: t.id, key: "2" });
    run({ projectId: alpha.id, key: "3", status: "skipped" });
    run({
      projectId: alpha.id,
      taskId: t.id,
      key: "4",
      automation: AUTOPILOT_REVIEW_PRS,
      summary: "Autopilot gave up on PR #7 after 3 review rounds",
    });
    // A run still going when the board restarts is failed by recover().
    const stranded = s.autopilot.record({
      automation: "auto_archive",
      candidate: {
        dedupeKey: "5",
        summary: "x",
        projectId: alpha.id,
        taskId: t.id,
      },
      dryRun: false,
    })!;
    s.autopilot.start(stranded.id);
    s.autopilot.recover();

    const runs = week().runs;
    const archive = runs.find((r) => r.key === "auto_archive")!;
    expect(archive).toMatchObject({
      total: 4,
      succeeded: 1,
      failed: 2,
      skipped: 1,
      retries: 2,
      gaveUp: 0,
    });
    // Both finish in the same millisecond of the frozen clock, so their order isn't fixed.
    expect(archive.failures).toHaveLength(2);
    expect(archive.failures).toEqual(
      expect.arrayContaining([
        {
          task: { number: t.number, title: "Flaky" },
          reason: "gh timed out",
          restarted: false,
        },
        {
          task: { number: t.number, title: "Flaky" },
          reason: "The board restarted while this run was going",
          restarted: true,
        },
      ]),
    );
    expect(runs.find((r) => r.key === AUTOPILOT_REVIEW_PRS)).toMatchObject({
      total: 1,
      gaveUp: 1,
    });
    // Most failures first.
    expect(runs[0]!.key).toBe("auto_archive");

    const text = renderActivity(week());
    expect(text).toContain("failed #" + t.number + " (board restarted) — The board restarted while this run was going");
    expect(text).toContain("failed #" + t.number + " — gh timed out");
    expect(text).toContain("2 retries");
  });

  it("groups findings by severity and area, and keeps PR review verdicts apart", () => {
    const { s, alpha, task, clock, run, week } = setup();
    const t = task(alpha.id, "Reviewed");
    clock(at(13));
    s.reviews.submit(
      t.id,
      {
        findings: [
          { severity: "nit", title: "Typo", file: "apps/web/src/a.ts" },
          {
            severity: "blocking",
            title: "Crash",
            file: "apps/server/src/x.ts",
            line: 3,
          },
          { severity: "major", title: "Leak", file: "apps/server/src/y.ts" },
          { severity: "minor", title: "Unattributed" },
        ],
      },
      "reviewer",
    );
    s.reviews.resolveFinding(t.id, "R1.2", { status: "fixed" }, "agent");
    run({
      projectId: alpha.id,
      taskId: t.id,
      key: "pr",
      automation: AUTOPILOT_REVIEW_PRS,
      output: {
        kind: "pr_review",
        linkId: "l",
        prUrl: "u",
        headOid: "h",
        round: 1,
        maxRounds: 3,
        reviewUrl: "r",
        reviewId: 1,
        counts: { blocking: 0, major: 2, minor: 1, nit: 0 },
        fyi: 1,
        threshold: "minor",
        actionable: 3,
        handoff: "fix",
      },
    });

    const text = renderActivity(week());
    expect(text).toContain("4 findings: 1 blocking, 1 major, 1 minor, 1 nit (3 open, 1 fixed)");
    expect(text).toContain("By area: apps/server/src (2), (no file) (1), apps/web/src (1)");
    // Most severe first.
    expect(text.indexOf("blocking #")).toBeLessThan(text.indexOf("nit #"));
    expect(text).toContain(`blocking #${t.number} R1.2 apps/server/src/x.ts: Crash`);
    expect(text).toContain(`#${t.number} round 1/3: 2 major, 1 minor, 1 FYI (fix)`);
  });

  it("lists stalls once per task and kind, and the notes agents left", () => {
    const { s, alpha, task, clock, run, week } = setup();
    const t = task(alpha.id, "Quiet");
    clock(at(13));
    run({
      projectId: alpha.id,
      taskId: t.id,
      key: "q",
      automation: AUTOPILOT_UNSTICK,
      summary: "Stale: no activity for 5h",
    });
    run({
      projectId: alpha.id,
      taskId: t.id,
      key: "w",
      automation: AUTOPILOT_UNSTICK,
      summary: "Thread waiting for input for 20m",
    });
    s.notifications.notify({
      kind: "thread_waiting",
      taskId: t.id,
      title: "Waiting",
      body: "",
      dedupeKey: "w1",
    });
    s.tasks.addNote(t.id, "Handover: next step is 2.1", "claude-code");
    s.tasks.addNote(t.id, "Stale: no activity for 5h", "autopilot");

    const { stalls, notes } = week();
    expect(stalls.map((x) => x.kind).sort()).toEqual(["stale", "waiting"]);
    // Autopilot's own notes are what the stall section already says.
    expect(notes.map((n) => n.text)).toEqual(["Handover: next step is 2.1"]);
  });

  it("cuts each section to its cap and says how many more", () => {
    const { s, alpha, task, clock, run } = setup();
    clock(at(13));
    const tasks = Array.from({ length: ACTIVITY_CAPS.finished + 3 }, (_, i) => task(alpha.id, `Done ${i}`));
    for (const [i, t] of tasks.entries()) {
      s.tasks.move(t.id, { status: "done" }, "agent");
      s.tasks.addNote(t.id, `note ${i}`, "agent");
    }
    s.reviews.submit(
      tasks[0]!.id,
      {
        findings: Array.from({ length: ACTIVITY_CAPS.titles + 2 }, (_, i) => ({
          severity: "minor" as const,
          title: `finding ${i}`,
          file: `src/f${i}.ts`,
        })),
      },
      "reviewer",
    );
    for (let i = 0; i < ACTIVITY_CAPS.failures + 4; i++) {
      run({
        projectId: alpha.id,
        key: `f${i}`,
        status: "failed",
        error: `boom ${i}`,
      });
    }

    const text = renderActivity(s.activity.between(at(12, 0), at(19, 0)));
    expect(text).toContain(`Tasks finished (${tasks.length}):`);
    expect(text.match(/^ {2}#\d+ Done/gm)).toHaveLength(ACTIVITY_CAPS.finished);
    expect(text).toContain("  (3 more)");
    expect(text).toContain("    (2 more)");
    expect(text).toContain("    (4 more)");
    expect(text).toContain(`Notes (${tasks.length}, newest first):`);
    expect(text).toContain(`(${tasks.length - ACTIVITY_CAPS.notes} more)`);
  });

  it("says none for an empty period", () => {
    const { s } = setup();
    const text = renderActivity(s.activity.between(at(1, 0), at(2, 0)));
    expect(text).toContain("Tasks finished (0):\n  none");
    expect(text).toContain("Review findings:\n  none");
    expect(text).toContain("Autopilot runs:\n  none");
    expect(text).toContain("Stalls (0):\n  none");
    expect(text).toContain("Notes (0, newest first):\n  none");
  });
});
