import { localStamp, type RecurringSchedule } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { AUTOPILOT_RECURRING, recurring } from "./recurring.ts";

const mondays: RecurringSchedule = { kind: "weekly", days: [1], time: "09:00" };
// 2026-10-05 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

function setup() {
  // Only Date is ours: the engine's passes are called by hand.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(5, 12));
  const h = createTestHarness({ integrations: { automations: [recurring] } });
  const s = h.services;
  const newEngine = () => {
    const engine = createAutopilotEngine({
      services: () => h.services,
      bus: h.bus,
      debounceMs: 5,
      tickMs: 1_000_000,
      log: { warn: () => {} },
    });
    engines.push(engine);
    return engine;
  };
  const engine = newEngine();
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const bump = s.templates.create({ name: "Bump", titlePattern: "Bump dependencies {{date}}", labels: ["deps"] });
  const audit = s.templates.create({
    name: "Audit",
    titlePattern: "Audit {{project}}",
    phases: [{ title: "Audit", steps: [{ title: "Run pnpm audit" }, { title: "Fix what it finds" }] }],
  });
  const turnOn = () => s.autopilot.setScope("project", project.id, AUTOPILOT_RECURRING, { mode: "on" });
  const rule = (input: { name?: string; templateId?: string; flagAutopilot?: boolean; schedule?: RecurringSchedule }) =>
    s.recurring.create(project.id, {
      name: input.name ?? "Weekly bump",
      templateId: input.templateId ?? bump.id,
      schedule: input.schedule ?? mondays,
      ...(input.flagAutopilot !== undefined ? { flagAutopilot: input.flagAutopilot } : {}),
    });
  const pass = async (when: Date, e: AutopilotEngine = engine) => {
    vi.setSystemTime(when);
    await e.pass();
    await e.idle();
  };
  const tasks = () => s.tasks.summaries({ projectId: project.id, includeArchived: true });
  const runs = () => s.autopilot.runsForProject(project.id);
  return { ...h, s, project, bump, audit, turnOn, rule, pass, tasks, runs, newEngine };
}

describe("recurring tasks", () => {
  it("creates a Backlog task from the template when a slot is due, as autopilot, with a note", async () => {
    const { s, turnOn, rule, pass, tasks, runs } = setup();
    turnOn();
    const r = rule({});
    await pass(at(12, 8, 59));
    expect(tasks()).toEqual([]);

    await pass(at(12, 9, 0));
    const [task] = tasks();
    expect(task).toMatchObject({ title: "Bump dependencies 2026-10-12", status: "backlog", labels: ["deps"] });
    const events = s.tasks.detail(task!.id).events;
    expect(events.find((e) => e.type === "created")?.actor).toBe("autopilot");
    expect(events.find((e) => e.type === "note")).toMatchObject({
      actor: "autopilot",
      payload: { text: "Created by Autopilot from recurring rule Weekly bump" },
    });
    expect(s.recurring.get(r.id)).toMatchObject({ lastTaskId: task!.id, lastDueAt: localStamp(at(12, 9)) });
    expect(runs()).toMatchObject([
      { automation: "recurring", status: "succeeded", summary: `Created #${task!.number} from "Weekly bump"` },
    ]);
  });

  it("makes a Planned task when the template has a plan, and flags it when asked", async () => {
    const { s, turnOn, rule, pass, tasks, audit, bump } = setup();
    turnOn();
    rule({ name: "Audit", templateId: audit.id, flagAutopilot: true });
    rule({ name: "Flagged bump", templateId: bump.id, flagAutopilot: true });
    rule({ name: "Plain bump", templateId: bump.id });
    await pass(at(12, 9, 1));
    const audits = tasks().filter((t) => t.title.startsWith("Audit"));
    expect(audits).toMatchObject([{ title: "Audit Alpha", status: "planned", autopilot: true }]);
    const bumps = tasks().filter((t) => t.title.startsWith("Bump"));
    expect(bumps.map((t) => [t.status, t.autopilot]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      ["backlog", null],
      ["backlog", true],
    ]);
    const planned = s.tasks.detail(audits[0]!.id);
    expect(planned.phases[0]!.steps.map((step) => step.title)).toEqual(["Run pnpm audit", "Fix what it finds"]);
  });

  it("does nothing while the automation is off for the project, or the rule is disabled", async () => {
    const { s, turnOn, rule, pass, tasks, runs } = setup();
    const r = rule({});
    await pass(at(12, 9, 1));
    expect(tasks()).toEqual([]);

    turnOn();
    s.recurring.update(r.id, { enabled: false });
    await pass(at(19, 9, 1));
    expect(tasks()).toEqual([]);
    expect(runs()).toEqual([]);
  });

  it("doesn't catch up on slots that passed before the rule existed or while it was off", async () => {
    const { s, turnOn, rule, pass, tasks } = setup();
    turnOn();
    // Created on Monday at 12:00, after that day's 09:00 slot.
    const r = rule({});
    await pass(at(5, 13));
    expect(tasks()).toEqual([]);

    s.recurring.update(r.id, { enabled: false });
    await pass(at(14, 12));
    s.recurring.update(r.id, { enabled: true });
    await pass(at(14, 13));
    expect(tasks()).toEqual([]);
    await pass(at(19, 9, 5));
    expect(tasks()).toHaveLength(1);
  });

  it("doesn't catch up when the project's automation is switched back on", async () => {
    const { s, project, turnOn, rule, pass, tasks } = setup();
    turnOn();
    rule({});
    await pass(at(6, 12));
    s.autopilot.setScope("project", project.id, AUTOPILOT_RECURRING, { mode: "off" });
    // Monday the 12th passes while it is off.
    await pass(at(13, 12));
    expect(tasks()).toEqual([]);
    turnOn();
    await pass(at(13, 12, 1));
    expect(tasks()).toEqual([]);
    // The 19th is on again.
    await pass(at(19, 9, 1));
    expect(tasks()).toHaveLength(1);
  });

  it("doesn't catch up when the board is switched on, or Pause all is lifted", async () => {
    const { s, project, rule, pass, tasks } = setup();
    s.autopilot.setScope("board", null, AUTOPILOT_RECURRING, { mode: "on" });
    rule({});
    await pass(at(6, 12));
    s.autopilot.setPaused(true);
    await pass(at(13, 12));
    s.autopilot.setPaused(false);
    await pass(at(13, 12, 1));
    expect(tasks()).toEqual([]);

    // A project that sets its own switch off, then inherits the board's On again, starts afresh too.
    s.autopilot.setScope("project", project.id, AUTOPILOT_RECURRING, { mode: "off" });
    await pass(at(20, 12));
    s.autopilot.setScope("project", project.id, AUTOPILOT_RECURRING, { mode: "inherit" });
    await pass(at(20, 12, 1));
    expect(tasks()).toEqual([]);
    await pass(at(26, 9, 1));
    expect(tasks()).toHaveLength(1);
  });

  it("creates one catch-up task after downtime, not one per missed slot", async () => {
    const { s, turnOn, rule, pass, tasks, runs } = setup();
    turnOn();
    const r = rule({});
    // Mondays the 12th, 19th and 26th all pass with no pass in between.
    await pass(at(28, 10));
    expect(tasks()).toHaveLength(1);
    expect(s.recurring.get(r.id).lastDueAt).toBe(localStamp(at(26, 9)));
    expect(runs()).toHaveLength(1);
    await pass(at(28, 11));
    expect(tasks()).toHaveLength(1);
  });

  it("doesn't create a duplicate after a restart, even if the run history is gone", async () => {
    const { db, turnOn, rule, pass, tasks, newEngine, runs } = setup();
    turnOn();
    rule({});
    await pass(at(12, 9, 1));
    expect(tasks()).toHaveLength(1);

    // A fresh engine knows nothing; the run's dedupe key and the rule's own cursor both hold.
    await pass(at(12, 9, 2), newEngine());
    expect(tasks()).toHaveLength(1);
    // Runs are history and not backed up, so a restore leaves them empty; the cursor still holds.
    db.exec("DELETE FROM autopilot_runs");
    await pass(at(12, 9, 3), newEngine());
    expect(tasks()).toHaveLength(1);
    expect(runs()).toEqual([]);
  });

  it("skips a slot while the last task is still open, and logs it", async () => {
    const { s, turnOn, rule, pass, tasks, runs } = setup();
    turnOn();
    const r = rule({});
    await pass(at(12, 9, 1));
    const [first] = tasks();

    await pass(at(19, 9, 1));
    expect(tasks()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({
      status: "skipped",
      summary: `Skipped "Weekly bump": #${first!.number} is still open`,
    });
    // The skipped slot is dealt with: the rule isn't due again until the next Monday.
    expect(s.recurring.get(r.id).lastDueAt).toBe(localStamp(at(19, 9)));
    await pass(at(19, 12));
    expect(runs()).toHaveLength(2);
  });

  it.each(["done", "closed", "archived"] as const)("creates again once the last task is %s", async (finish) => {
    const { s, turnOn, rule, pass, tasks } = setup();
    turnOn();
    rule({});
    await pass(at(12, 9, 1));
    const first = tasks()[0]!;
    if (finish === "done") {
      s.plans.setPlan(first.id, { phases: [{ title: "x", steps: [{ title: "y" }] }] }, "user");
      s.tasks.move(first.id, { status: "done" }, "user");
    }
    if (finish === "closed") s.tasks.close(first.id, { resolution: "wont_do" }, "user");
    if (finish === "archived") s.tasks.update(first.id, { archived: true }, "user");
    await pass(at(19, 9, 1));
    expect(tasks()).toHaveLength(2);
  });

  it("only previews in dry-run, and creates the task once dry-run is off", async () => {
    const { s, turnOn, rule, pass, tasks, runs } = setup();
    turnOn();
    const r = rule({});
    s.autopilot.updateEngine({ dryRun: true });
    await pass(at(12, 9, 1));
    expect(tasks()).toEqual([]);
    expect(runs()).toMatchObject([
      { status: "skipped", dryRun: true, summary: 'Would create a task from recurring rule "Weekly bump"' },
    ]);
    // The preview doesn't use the slot up.
    expect(s.recurring.get(r.id).lastDueAt).not.toBe(localStamp(at(12, 9)));

    s.autopilot.updateEngine({ dryRun: false });
    await pass(at(12, 9, 2));
    expect(tasks()).toHaveLength(1);
  });

  it("fails the run, and still moves on, when the template was deleted", async () => {
    const { s, turnOn, rule, pass, tasks, runs, bump } = setup();
    turnOn();
    const r = rule({});
    s.templates.delete(bump.id);
    expect(s.recurring.get(r.id).templateId).toBeNull();
    await pass(at(12, 9, 1));
    expect(tasks()).toEqual([]);
    expect(runs()).toMatchObject([
      { status: "failed", error: expect.stringContaining('template of "Weekly bump" was deleted') },
    ]);
    expect(s.recurring.get(r.id).lastDueAt).toBe(localStamp(at(12, 9)));
  });

  it("works on an every-N-days schedule from a start date", async () => {
    const { turnOn, rule, pass, tasks, runs } = setup();
    turnOn();
    rule({ schedule: { kind: "every", everyDays: 10, startDate: "2026-10-01", time: "06:30" } });
    await pass(at(10, 6, 29));
    expect(tasks()).toEqual([]);
    await pass(at(11, 6, 30));
    expect(tasks()).toHaveLength(1);
    // The task is still open on the 21st: skipped, not duplicated.
    await pass(at(21, 7));
    expect(tasks()).toHaveLength(1);
    expect(runs()[0]?.status).toBe("skipped");
  });
});
