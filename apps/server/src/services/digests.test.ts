import { DIGEST_KEEP } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.ts";

// 2026-10-12 is a Monday.
const at = (hour: number, minute = 0) => new Date(2026, 9, 12, hour, minute);
const plan = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

afterEach(() => vi.useRealTimers());

interface RunInput {
  projectId: string;
  taskId?: string;
  key: string;
  status?: "succeeded" | "failed";
  costUsd?: number;
  automation?: string;
  error?: string;
}

function setup() {
  // Only Date is ours: activity is stamped with it, and the clock is moved by hand.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(8));
  const h = createTestHarness();
  const s = h.services;
  const alpha = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const beta = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const task = (projectId: string, title: string) => s.tasks.create({ projectId, title, plan });
  const clock = (when: Date) => vi.setSystemTime(when);
  const run = (input: RunInput) => {
    const recorded = s.autopilot.record({
      automation: input.automation ?? "auto_archive",
      candidate: {
        dedupeKey: input.key,
        summary: "start it",
        projectId: input.projectId,
        taskId: input.taskId ?? null,
      },
      dryRun: false,
    })!;
    s.autopilot.start(recorded.id);
    s.autopilot.finish(recorded.id, {
      status: input.status ?? "succeeded",
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
  };
  return { ...h, s, alpha, beta, task, clock, run };
}

describe("digests.collect", () => {
  it("groups the period's activity by project", () => {
    const { s, alpha, beta, task, clock, run } = setup();
    const a = task(alpha.id, "Add exports");
    const b = task(alpha.id, "Flaky");
    const c = task(beta.id, "Fix build");
    clock(at(9));
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    s.tasks.move(b.id, { status: "in_progress" }, "agent");
    clock(at(10));
    s.tasks.move(a.id, { status: "review" }, "agent");
    // Back where it started: nothing to report.
    s.tasks.move(b.id, { status: "planned" }, "agent");
    s.tasks.move(c.id, { status: "done" }, "github", { mergedPr: "acme/app#7" });
    clock(at(11));
    s.notifications.notify({
      kind: "pr_checks_failing",
      taskId: b.id,
      title: "Checks failing",
      body: "",
      dedupeKey: "checks:1",
    });
    // Failed runs have their own section, and a digest's own runs are left out.
    s.notifications.notify({ kind: "autopilot_failed", taskId: b.id, title: "x", body: "", dedupeKey: "run:1" });
    run({ projectId: alpha.id, taskId: b.id, key: "k1", costUsd: 0.5 });
    run({ projectId: alpha.id, taskId: b.id, key: "k2", status: "failed", costUsd: 0.25, error: "boom" });
    run({ projectId: alpha.id, key: "k3", automation: "digest", costUsd: 9 });
    run({ projectId: beta.id, key: "k4" });

    const data = s.digests.collect(at(8, 30), at(12));
    expect(data.projects.map((p) => p.title)).toEqual(["Alpha", "Beta"]);
    const [alphaData, betaData] = data.projects;
    expect(alphaData).toMatchObject({
      moves: [{ number: a.number, title: "Add exports", from: "planned", to: "review" }],
      merged: [],
      attention: [{ number: b.number, kind: "pr_checks_failing" }],
      runs: {
        total: 2,
        succeeded: 1,
        failed: 1,
        problems: [{ number: b.number, automation: "Auto-archive Done", failed: true, message: "boom" }],
      },
    });
    expect(betaData).toMatchObject({
      moves: [],
      merged: [{ number: c.number, title: "Fix build", pr: "acme/app#7" }],
      runs: { total: 1, succeeded: 1, failed: 0, problems: [] },
    });
    expect(data.costUsd).toBeCloseTo(0.75);
  });

  it("counts a run in the period it finished in, and leaves an unfinished one for later", () => {
    const { s, alpha, task, clock } = setup();
    const a = task(alpha.id, "Slow job");
    clock(at(9));
    const slow = s.autopilot.record({
      automation: "auto_archive",
      candidate: { dedupeKey: "slow", summary: "work", projectId: alpha.id, taskId: a.id },
      dryRun: false,
    })!;
    s.autopilot.start(slow.id);
    // Still going at the end of the first period.
    expect(s.digests.collect(at(8), at(10)).projects[0]!.runs.total).toBe(0);
    clock(at(11));
    s.autopilot.finish(slow.id, { status: "failed", error: "gave up" });
    expect(s.digests.collect(at(10), at(12)).projects[0]!.runs).toMatchObject({
      total: 1,
      failed: 1,
      problems: [{ message: "gave up" }],
    });
  });

  it("takes the start of the period in and the end out", () => {
    const { s, alpha, task, clock } = setup();
    const a = task(alpha.id, "Add exports");
    clock(at(10));
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    clock(at(11));
    s.tasks.move(a.id, { status: "review" }, "agent");

    // Includes the move at 10:00, leaves out the one at 11:00.
    expect(s.digests.collect(at(10), at(11)).projects[0]!.moves).toMatchObject([
      { from: "planned", to: "in_progress" },
    ]);
    expect(s.digests.collect(at(10, 1), at(11, 1)).projects[0]!.moves).toMatchObject([
      { from: "in_progress", to: "review" },
    ]);
    expect(s.digests.collect(at(11, 1), at(12)).projects[0]!.moves).toEqual([]);
  });

  it("leaves out projects with the digest switched Off, and still covers the others", () => {
    const { s, alpha, beta, task, clock } = setup();
    const a = task(alpha.id, "Add exports");
    const b = task(beta.id, "Fix build");
    s.autopilot.setScope("board", null, "digest", { mode: "on" });
    s.autopilot.setScope("project", beta.id, "digest", { mode: "off" });
    clock(at(9));
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    s.tasks.move(b.id, { status: "in_progress" }, "agent");
    expect(s.digests.collect(at(8), at(10)).projects.map((p) => p.title)).toEqual(["Alpha"]);
  });

  it("leaves out archived projects", () => {
    const { s, beta } = setup();
    s.projects.update(beta.id, { archived: true });
    expect(s.digests.collect(at(8), at(10)).projects.map((p) => p.title)).toEqual(["Alpha"]);
  });
});

describe("digests.period", () => {
  it("covers the last 24 hours at first, then from where the previous digest ended", () => {
    const { s, clock } = setup();
    expect(s.digests.period(at(9))).toEqual({ from: new Date(2026, 9, 11, 9), to: at(9) });
    clock(at(9));
    const first = s.digests.create({
      from: new Date(2026, 9, 11, 9),
      to: at(9),
      mode: "plain",
      trigger: "schedule",
      bodyMd: "x",
      costUsd: null,
      note: null,
      headline: "Nothing changed",
    });
    expect(s.digests.period(at(15))).toEqual({ from: new Date(first.to), to: at(15) });
  });
});

describe("digests.create", () => {
  const input = (n: number) => ({
    from: at(8),
    to: at(9),
    mode: "plain" as const,
    trigger: "manual" as const,
    bodyMd: `body ${n}`,
    costUsd: null,
    note: null,
    headline: "3 moved · 1 PR merged",
  });

  it("stores it unread, tells the inbox once, and tells open browsers", () => {
    const { s, events } = setup();
    const digest = s.digests.create(input(1));
    expect(digest).toMatchObject({ bodyMd: "body 1", readAt: null, mode: "plain", trigger: "manual" });
    expect(s.digests.list()).toMatchObject({ items: [{ id: digest.id }], unread: 1 });
    expect(s.notifications.list().items).toMatchObject([
      { kind: "autopilot_notice", taskId: null, title: "Digest of what changed", body: "3 moved · 1 PR merged" },
    ]);
    expect(events.some((e) => e.type === "autopilot.changed")).toBe(true);
  });

  it("keeps the newest 30, newest first", () => {
    const { s, clock } = setup();
    for (let n = 1; n <= DIGEST_KEEP + 2; n++) {
      clock(new Date(2026, 9, 12, 9, n));
      s.digests.create(input(n));
    }
    const { items } = s.digests.list();
    expect(items).toHaveLength(DIGEST_KEEP);
    expect(items[0]!.bodyMd).toBe(`body ${DIGEST_KEEP + 2}`);
    expect(items.at(-1)!.bodyMd).toBe("body 3");
  });

  it("marks one read at a time", () => {
    const { s, clock } = setup();
    const first = s.digests.create(input(1));
    clock(at(9, 5));
    const second = s.digests.create(input(2));
    expect(s.digests.list().unread).toBe(2);
    expect(s.digests.markRead(first.id).readAt).not.toBeNull();
    expect(s.digests.list()).toMatchObject({ unread: 1 });
    expect(s.digests.get(second.id).readAt).toBeNull();
    // Reading it again changes nothing.
    expect(s.digests.markRead(first.id).readAt).toBe(s.digests.get(first.id).readAt);
    expect(() => s.digests.markRead("nope")).toThrow(/not found/i);
  });
});
