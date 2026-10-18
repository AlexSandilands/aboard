import {
  brandEnv,
  customAutomationKey,
  type CreateCustomAutomationInput,
  type PlanInput,
  type PrSnapshot,
} from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ShellRequest, ShellResult } from "../integrations/shellCommand.ts";
import { createTestHarness } from "../test/harness.ts";
import { AUTOPILOT_BACKGROUND_MAX, createAutopilotEngine, type AutopilotEngine } from "./engine.ts";
import type { RunnerRequest } from "./types.ts";

const plan: PlanInput = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const HOUR = 3_600_000;

/** Lets the clock move on, so stamps taken before and after differ. */
const tick = () => new Promise((r) => setTimeout(r, 5));

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup(opts: { shell?: (request: ShellRequest) => ShellResult | Promise<ShellResult> } = {}) {
  let offsetMs = 0;
  const shellRuns: ShellRequest[] = [];
  const h = createTestHarness({
    integrations: {
      automations: [],
      runShell: async (request) => {
        shellRuns.push(request);
        return opts.shell ? opts.shell(request) : { exitCode: 0, output: "ok\n", timedOut: false };
      },
    },
  });
  const agentRuns: RunnerRequest[] = [];
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: {
      start: (request) => {
        agentRuns.push(request);
        return Promise.resolve({ runner: "t3", threadUrl: "t3code://threads/env/t1", result: null });
      },
    },
    now: () => new Date(Date.now() + offsetMs),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const task = (title: string, extra: { projectId?: string; labels?: string[]; blockedBy?: string[] } = {}) =>
    s.tasks.create({ projectId: extra.projectId ?? project.id, title, plan, ...extra });
  const define = (input: CreateCustomAutomationInput, mode: "on" | null = "on") => {
    const custom = s.customAutomations.create(input);
    if (mode) s.autopilot.setScope("board", null, customAutomationKey(custom.id), { mode });
    return custom;
  };
  const pass = async (laterMs = 0) => {
    offsetMs = laterMs;
    await engine.pass();
    await engine.idle();
  };
  const runsOf = (projectId = project.id) => s.autopilot.runsForProject(projectId);
  const shell = (command = "./notify.sh") => ({ kind: "shell" as const, command, timeoutSeconds: 30 });
  return { ...h, s, engine, project, other, task, define, pass, runsOf, shellRuns, agentRuns, shell };
}

const pr = (patch: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Change",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feature/x",
  updatedAt: new Date().toISOString(),
  headOid: "abc123",
  ...patch,
});

describe("custom automations: triggers", () => {
  it("acts when a task moves into the column, once per move, and not on tasks already there", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    const before = task("Already in review");
    s.tasks.move(before.id, { status: "review" }, "agent");
    define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() });
    const t = task("Moves");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_NUMBER")])).toEqual([String(t.number)]);
    await pass();
    expect(shellRuns).toHaveLength(1);
    // Back out and in again is a new move.
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns).toHaveLength(2);
  });

  it("only counts moves from the column it names", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    define({ name: "Reopened", trigger: { kind: "status_change", from: "done", to: "in_progress" }, action: shell() });
    const a = task("From planned");
    const b = task("From done");
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    s.tasks.move(b.id, { status: "done" }, "agent");
    s.tasks.move(b.id, { status: "in_progress" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([b.id]);
  });

  it("reads where a closed task came from", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    define({ name: "Closed", trigger: { kind: "status_change", from: "review", to: "done" }, action: shell() });
    const t = task("Closed from review");
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    s.tasks.move(t.id, { status: "review" }, "agent");
    s.tasks.close(t.id, { resolution: "wont_do" }, "agent");
    const other = task("Closed from planned");
    s.tasks.move(other.id, { status: "review" }, "agent");
    s.tasks.move(other.id, { status: "planned" }, "agent");
    s.tasks.close(other.id, { resolution: "wont_do" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([t.id]);
  });

  it("acts on PR events: linked, each time checks start failing, new commits and the merge", async () => {
    const { s, task, define, pass, runsOf, shell } = setup();
    const t = task("With a PR");
    const linked = define({ name: "Linked", trigger: { kind: "pr_event", event: "linked" }, action: shell() });
    const failing = define({ name: "Checks", trigger: { kind: "pr_event", event: "checks_failing" }, action: shell() });
    const head = define({ name: "Head", trigger: { kind: "pr_event", event: "new_head" }, action: shell() });
    const merged = define({ name: "Merged", trigger: { kind: "pr_event", event: "merged" }, action: shell() });
    const link = s.links.add(t.id, { value: "https://github.com/o/r/pull/7" }, "agent");
    // The first snapshot is what the PR was like when linked: nothing has begun yet.
    s.links.setSnapshot(link.id, pr());
    s.links.setSnapshot(link.id, pr({ checks: "failing" }));
    await pass();
    // Still failing on the next push is the same failure; passing and failing again is a new one.
    await tick();
    s.links.setSnapshot(link.id, pr({ checks: "failing", headOid: "def456" }));
    await pass();
    s.links.setSnapshot(link.id, pr({ checks: "passing", headOid: "def456" }));
    await tick();
    s.links.setSnapshot(link.id, pr({ checks: "failing", headOid: "def456" }));
    await pass();
    s.links.setSnapshot(link.id, pr({ state: "merged", headOid: "def456" }));
    await pass();
    const by = (key: string) => runsOf().filter((r) => r.automation === customAutomationKey(key));
    expect(by(linked.id)).toHaveLength(1);
    expect(by(failing.id)).toHaveLength(2);
    // The head the PR had when it was linked isn't new; def456 replacing it is.
    expect(by(head.id).map((r) => r.dedupeKey)).toEqual([`pr_head:${link.id}:def456`]);
    expect(by(merged.id)).toHaveLength(1);
  });

  it("doesn't fire for states it finds in place on a PR's first snapshot, as after a restore", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    define({ name: "Merged", trigger: { kind: "pr_event", event: "merged" }, action: shell() });
    define({ name: "Checks", trigger: { kind: "pr_event", event: "checks_failing" }, action: shell() });
    const t = task("Restored");
    const link = s.links.add(t.id, { value: "https://github.com/o/r/pull/11" }, "agent");
    s.links.setSnapshot(link.id, pr({ state: "merged", checks: "failing" }));
    await pass();
    expect(shellRuns).toHaveLength(0);
  });

  it("doesn't take a comment on an old merged PR for a new merge", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    const t = task("Merged long ago");
    const link = s.links.add(t.id, { value: "https://github.com/o/r/pull/9" }, "agent");
    s.links.setSnapshot(link.id, pr({ state: "merged", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await tick();
    define({ name: "Deploy", trigger: { kind: "pr_event", event: "merged" }, action: shell() });
    s.links.setSnapshot(link.id, pr({ state: "merged", updatedAt: new Date().toISOString() }));
    await pass();
    expect(shellRuns).toHaveLength(0);
  });

  it("ignores a PR whose state is older than the automation", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    const t = task("Old PR");
    const link = s.links.add(t.id, { value: "https://github.com/o/r/pull/8" }, "agent");
    s.links.setSnapshot(link.id, pr({ checks: "failing", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await new Promise((r) => setTimeout(r, 5));
    define({ name: "Checks", trigger: { kind: "pr_event", event: "checks_failing" }, action: shell() });
    await pass();
    expect(shellRuns).toHaveLength(0);
  });

  it("runs a schedule once per slot in each project in scope", async () => {
    const { s, define, pass, runsOf, other, project, shellRuns, shell } = setup();
    const custom = define({
      name: "Hourly",
      trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } },
      filters: { projectIds: [project.id] },
      action: shell(),
    });
    await pass();
    // The slot it was made in had passed already.
    expect(shellRuns).toHaveLength(0);
    await pass(HOUR);
    // The same slot again: no second run.
    await pass(HOUR);
    expect(shellRuns).toHaveLength(1);
    expect(shellRuns[0]).toMatchObject({ cwd: "/work/alpha" });
    expect(shellRuns[0]!.env[brandEnv("TASK_NUMBER")]).toBe("");
    expect(runsOf()[0]).toMatchObject({ automation: customAutomationKey(custom.id), taskId: null });
    expect(runsOf(other.id)).toHaveLength(0);
    expect(s.autopilot.runsForProject(project.id)[0]!.dedupeKey).toMatch(/^schedule:/);
  });

  it("runs a schedule's slot in every project it is on in, not just the first", async () => {
    const { define, pass, shellRuns, shell } = setup();
    define({
      name: "Hourly",
      trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } },
      action: shell(),
    });
    await pass(HOUR);
    expect(shellRuns.map((r) => r.cwd).sort()).toEqual(["/work/alpha", "/work/beta"]);
  });

  it("acts on a task that has sat in its column too long, once per stint", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    const t = task("Stuck");
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    define({ name: "Stale", trigger: { kind: "stale", status: "in_progress", hours: 24 }, action: shell() });
    await pass(23 * HOUR);
    expect(shellRuns).toHaveLength(0);
    await pass(25 * HOUR);
    await pass(26 * HOUR);
    expect(shellRuns).toHaveLength(1);
  });

  it("acts when a task's last blocker finishes", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    const a = task("A");
    const b = task("B");
    const dependent = task("Dependent", { blockedBy: [a.id, b.id] });
    define({ name: "Unblocked", trigger: { kind: "blocker_finished" }, action: shell() });
    s.tasks.move(a.id, { status: "done" }, "agent");
    await pass();
    expect(shellRuns).toHaveLength(0);
    s.tasks.move(b.id, { status: "done" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([dependent.id]);
  });
});

describe("custom automations: filters and scopes", () => {
  it("filters by project, label and epic", async () => {
    const { s, task, define, pass, shellRuns, other, project, shell } = setup();
    const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    define({
      name: "Filtered",
      trigger: { kind: "status_change", to: "in_progress" },
      filters: { projectIds: [project.id], labels: ["UI"], epicId: epic.id },
      action: shell(),
    });
    const hit = task("Hit", { labels: ["ui"] });
    s.tasks.update(hit.id, { epicId: epic.id }, "agent");
    const noLabel = task("No label");
    s.tasks.update(noLabel.id, { epicId: epic.id }, "agent");
    const noEpic = task("No epic", { labels: ["ui"] });
    const elsewhere = task("Elsewhere", { projectId: other.id, labels: ["ui"] });
    for (const t of [hit, noLabel, noEpic, elsewhere]) s.tasks.move(t.id, { status: "in_progress" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([hit.id]);
  });

  it("follows its Inherit/On/Off switches like a built-in automation", async () => {
    const { s, task, define, pass, shellRuns, other, shell } = setup();
    const custom = define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() });
    s.autopilot.setScope("project", other.id, customAutomationKey(custom.id), { mode: "off" });
    const here = task("Here");
    const there = task("There", { projectId: other.id });
    s.tasks.move(here.id, { status: "review" }, "agent");
    s.tasks.move(there.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([here.id]);
  });

  it("doesn't act on what happened while it was off once it is switched on", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    const custom = define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() }, null);
    const t = task("Moved while off");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await new Promise((r) => setTimeout(r, 5));
    s.autopilot.setScope("board", null, customAutomationKey(custom.id), { mode: "on" });
    await pass();
    expect(shellRuns).toHaveLength(0);
  });

  it("keeps a project's waiting events when it is switched on in another", async () => {
    const { s, task, define, pass, shellRuns, other, shell } = setup();
    const custom = define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() });
    const key = customAutomationKey(custom.id);
    s.autopilot.setScope("project", other.id, key, { mode: "off" });
    const here = task("Here");
    s.tasks.move(here.id, { status: "review" }, "agent");
    const there = task("There", { projectId: other.id });
    s.tasks.move(there.id, { status: "review" }, "agent");
    await tick();
    // Before any pass: switching Beta on arms Beta, not Alpha.
    s.autopilot.setScope("project", other.id, key, { mode: "on" });
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([here.id]);
  });

  it("applies per epic, and doesn't act on an epic's old events when switched on for it", async () => {
    const { s, task, define, pass, shellRuns, project, shell } = setup();
    const custom = define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() }, null);
    const key = customAutomationKey(custom.id);
    const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    const before = task("Moved before");
    s.tasks.update(before.id, { epicId: epic.id }, "agent");
    s.tasks.move(before.id, { status: "review" }, "agent");
    await tick();
    s.autopilot.setScope("epic", epic.id, key, { mode: "on" }, project.id);
    const inEpic = task("In the epic");
    s.tasks.update(inEpic.id, { epicId: epic.id }, "agent");
    const outside = task("Outside it");
    s.tasks.move(inEpic.id, { status: "review" }, "agent");
    s.tasks.move(outside.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns.map((r) => r.env[brandEnv("TASK_ID")])).toEqual([inEpic.id]);
  });

  describe("epic arming", () => {
    const epicSetup = () => {
      const ctx = setup();
      const { s, project, define, shell } = ctx;
      const custom = define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() }, null);
      const key = customAutomationKey(custom.id);
      const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
      const inEpic = (title: string) => {
        const t = ctx.task(title);
        s.tasks.update(t.id, { epicId: epic.id }, "agent");
        return t;
      };
      const setEpic = (mode: "on" | "off" | "inherit") =>
        s.autopilot.setScope("epic", epic.id, key, { mode }, project.id);
      const setProject = (mode: "on" | "off" | "inherit") => s.autopilot.setScope("project", project.id, key, { mode });
      const ran = () => ctx.shellRuns.map((r) => r.env[brandEnv("TASK_ID")]);
      return { ...ctx, key, epic, inEpic, setEpic, setProject, ran };
    };

    it("arms an epic set back to Inherit in a project that is on, so its Off time doesn't run", async () => {
      const { s, inEpic, setEpic, setProject, pass, ran } = epicSetup();
      setProject("on");
      setEpic("off");
      const t = inEpic("Moved while the epic was off");
      s.tasks.move(t.id, { status: "review" }, "agent");
      await pass();
      await tick();
      setEpic("inherit");
      await pass();
      expect(ran()).toEqual([]);
      const later = inEpic("Moved after");
      s.tasks.move(later.id, { status: "review" }, "agent");
      await pass();
      expect(ran()).toEqual([later.id]);
    });

    it("doesn't act on what a task did before it joined an epic that is on", async () => {
      const { s, task, epic, setEpic, pass, ran } = epicSetup();
      setEpic("on");
      const t = task("Outside, then in");
      s.tasks.move(t.id, { status: "review" }, "agent");
      await tick();
      s.tasks.update(t.id, { epicId: epic.id }, "agent");
      await pass();
      expect(ran()).toEqual([]);
    });

    it("keeps an epic's waiting events when its project is switched on as well", async () => {
      const { s, inEpic, setEpic, setProject, pass, ran } = epicSetup();
      setEpic("on");
      const t = inEpic("Waiting");
      s.tasks.move(t.id, { status: "review" }, "agent");
      await tick();
      setProject("on");
      await pass();
      expect(ran()).toEqual([t.id]);
    });

    it("arms epics that are on again when Autopilot resumes", async () => {
      const { s, inEpic, setEpic, pass, ran } = epicSetup();
      setEpic("on");
      s.autopilot.setPaused(true);
      const t = inEpic("Moved while paused");
      s.tasks.move(t.id, { status: "review" }, "agent");
      await tick();
      s.autopilot.setPaused(false);
      await pass();
      expect(ran()).toEqual([]);
    });

    it("keeps an epic's floor when it gets a setting of its own while already on through its project", async () => {
      const { s, inEpic, setEpic, setProject, pass, ran } = epicSetup();
      const t = inEpic("Moved while the project was off");
      s.tasks.move(t.id, { status: "review" }, "agent");
      await tick();
      setProject("on");
      await tick();
      setEpic("on");
      await pass();
      expect(ran()).toEqual([]);
    });

    it("keeps an epic's floor when it gets a config-only setting", async () => {
      const ctx = setup();
      const { s, project, define, pass } = ctx;
      const custom = define(
        { name: "Agent", trigger: { kind: "status_change", to: "review" }, action: { kind: "agent", prompt: "Go" } },
        null,
      );
      const key = customAutomationKey(custom.id);
      const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
      const t = ctx.task("Moved while the project was off");
      s.tasks.update(t.id, { epicId: epic.id }, "agent");
      s.tasks.move(t.id, { status: "review" }, "agent");
      await tick();
      s.autopilot.setScope("project", project.id, key, { mode: "on" });
      // A row for the epic that only tunes config: its tasks now follow the epic, which inherits On.
      s.autopilot.setScope("epic", epic.id, key, { mode: "inherit", config: { budgetUsd: 2 } }, project.id);
      expect(s.autopilot.epicsWithOwnSetting({ key }).has(epic.id)).toBe(true);
      await pass();
      expect(ctx.agentRuns).toEqual([]);
    });

    it("doesn't bring back an Off epic's events when it is archived in a project that is on", async () => {
      const ctx = setup();
      const { s, project, define, shell, pass } = ctx;
      const custom = define({ name: "Done", trigger: { kind: "status_change", to: "done" }, action: shell() }, null);
      const key = customAutomationKey(custom.id);
      const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
      s.autopilot.setScope("project", project.id, key, { mode: "on" });
      s.autopilot.setScope("epic", epic.id, key, { mode: "off" }, project.id);
      const t = ctx.task("Finished while the epic was off");
      s.tasks.update(t.id, { epicId: epic.id }, "agent");
      s.tasks.move(t.id, { status: "done" }, "agent");
      await pass();
      await tick();
      s.tasks.update(epic.id, { archived: true }, "user");
      await pass();
      expect(ctx.shellRuns).toEqual([]);
    });

    it("drops the epic switches when the trigger becomes a schedule", () => {
      const { s, key, epic, setEpic } = epicSetup();
      setEpic("on");
      const id = key.slice("custom:".length);
      s.customAutomations.update(id, { trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } } });
      s.customAutomations.update(id, { trigger: { kind: "status_change", to: "review" } });
      expect(s.autopilot.scope("epic", epic.id, epic.projectId).find((e) => e.automation === key)?.mode).toBe(
        "inherit",
      );
    });
  });

  it("leaves a schedule out of epic scope, since it has no task", () => {
    const { s, define, shell } = setup();
    const scheduled = define(
      { name: "Hourly", trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } }, action: shell() },
      null,
    );
    const onTasks = define({ name: "Ping", trigger: { kind: "stale", hours: 2 }, action: shell() }, null);
    const listed = s.autopilot.overview().automations;
    expect(listed.find((a) => a.key === customAutomationKey(scheduled.id))?.epicScope).toBe(false);
    expect(listed.find((a) => a.key === customAutomationKey(onTasks.id))?.epicScope).toBe(true);
  });

  it("does nothing while paused, and doesn't catch up on resume", async () => {
    const { s, task, define, pass, shellRuns, shell } = setup();
    define({ name: "Ping", trigger: { kind: "status_change", to: "review" }, action: shell() });
    s.autopilot.setPaused(true);
    const t = task("Moved while paused");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 5));
    s.autopilot.setPaused(false);
    await pass();
    expect(shellRuns).toHaveLength(0);
  });

  it("holds agent actions at the caps and in quiet hours, but not shell commands", async () => {
    const { s, task, define, pass, shellRuns, agentRuns, shell } = setup();
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "00:00", end: "23:59" } });
    define({
      name: "Agent",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "agent", prompt: "Go" },
    });
    define({ name: "Shell", trigger: { kind: "status_change", to: "review" }, action: shell() });
    const t = task("Moves");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(agentRuns).toHaveLength(0);
    expect(shellRuns).toHaveLength(1);
    s.autopilot.updateEngine({ quietHours: { enabled: false }, dailyRunCap: 1 });
    await pass();
    expect(agentRuns).toHaveLength(1);
    const second = task("Second");
    s.tasks.move(second.id, { status: "review" }, "agent");
    await pass();
    expect(agentRuns).toHaveLength(1);
  });
});

describe("custom automations: actions", () => {
  it("starts an agent with the filled prompt, the skill, the task's context, its tier and the PR branch", async () => {
    const { s, task, define, pass, agentRuns, runsOf } = setup();
    define({
      name: "Fix checks",
      trigger: { kind: "pr_event", event: "checks_failing" },
      action: {
        kind: "agent",
        prompt: "Fix #{{task.number}} {{task.title}} at {{pr.url}} in {{project.path}}",
        skill: "fix-ci",
        tier: "light",
        onPrBranch: true,
      },
    });
    const t = task("Flaky test");
    s.tasks.update(t.id, { description: "The suite fails on Windows." }, "agent");
    const link = s.links.add(t.id, { value: "https://github.com/o/r/pull/9" }, "agent");
    s.links.setSnapshot(link.id, pr());
    s.links.setSnapshot(link.id, pr({ checks: "failing" }));
    await pass();
    expect(agentRuns).toHaveLength(1);
    const request = agentRuns[0]!;
    expect(request.label).toBe(`Fix checks · #${t.number}`);
    expect(request.prompt).toContain("Use the fix-ci skill.");
    expect(request.prompt).toContain(`Fix #${t.number} Flaky test at https://github.com/o/r/pull/9 in /work/alpha`);
    expect(request.prompt).toContain("The suite fails on Windows.");
    expect(request.tier).toBe("light");
    expect(request.workspace).toEqual({ branch: "feature/x" });
    expect(request.options).toMatchObject({ runner: "auto", budgetUsd: 5 });
    expect(runsOf()[0]).toMatchObject({ status: "succeeded", threadUrl: "t3code://threads/env/t1" });
  });

  it("gives the agent the extra tools the action allows, and none when it allows none", async () => {
    const { s, task, define, pass, agentRuns } = setup();
    const trigger = { kind: "status_change" as const, to: "review" as const };
    const tools = ["mcp__issue-tracker", "mcp__issue-tracker__search_jira"];
    define({ name: "With", trigger, action: { kind: "agent", prompt: "Go", allowedTools: tools } });
    const t = task("Moves");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]!.tools).toEqual(tools);

    const { s: s2, task: task2, define: define2, pass: pass2, agentRuns: runs2 } = setup();
    define2({ name: "Without", trigger, action: { kind: "agent", prompt: "Go" } });
    s2.tasks.move(task2("Moves").id, { status: "review" }, "agent");
    await pass2();
    expect(runs2).toHaveLength(1);
    expect(runs2[0]).not.toHaveProperty("tools");
  });

  it("refuses an allowed tool that isn't a tool or server name", () => {
    const { s } = setup();
    expect(() =>
      s.customAutomations.create({
        name: "Bad",
        trigger: { kind: "stale", hours: 3 },
        action: { kind: "agent", prompt: "Go", allowedTools: ["issue-tracker"] },
      }),
    ).toThrow(/mcp__/);
  });

  it("passes task values to a shell command only as environment variables", async () => {
    const { s, define, pass, shellRuns, runsOf, project } = setup();
    define({
      name: "Echo",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "shell", command: "echo done", timeoutSeconds: 10 },
    });
    const t = s.tasks.create({ projectId: project.id, title: '"; rm -rf ~ #', plan });
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns[0]).toMatchObject({ command: "echo done", cwd: "/work/alpha", timeoutMs: 10_000 });
    expect(shellRuns[0]!.env).toMatchObject({
      [brandEnv("TASK_TITLE")]: '"; rm -rf ~ #',
      [brandEnv("TASK_STATUS")]: "review",
      [brandEnv("PROJECT_PATH")]: "/work/alpha",
      [brandEnv("AUTOMATION")]: "Echo",
    });
    expect(runsOf()[0]).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      detail: "ok\n",
      summary: `Ran "Echo" for #${t.number}`,
    });
  });

  it("runs at most a few commands at once, and starts the rest as they finish", async () => {
    const releases: Array<() => void> = [];
    const { s, task, define, pass, engine, shellRuns, shell } = setup({
      shell: () => new Promise((resolve) => releases.push(() => resolve({ exitCode: 0, output: "", timedOut: false }))),
    });
    define({ name: "Slow", trigger: { kind: "status_change", to: "review" }, action: shell() });
    for (let i = 0; i < AUTOPILOT_BACKGROUND_MAX + 2; i++)
      s.tasks.move(task(`T${i}`).id, { status: "review" }, "agent");
    await engine.pass();
    expect(shellRuns).toHaveLength(AUTOPILOT_BACKGROUND_MAX);
    for (const release of releases.splice(0)) release();
    await new Promise((r) => setTimeout(r, 50));
    await engine.pass();
    expect(shellRuns).toHaveLength(AUTOPILOT_BACKGROUND_MAX + 2);
    for (const release of releases.splice(0)) release();
    await pass();
  });

  it("fails and flags the task when the command exits non-zero or times out", async () => {
    let call = 0;
    const { s, task, define, pass, runsOf, shell } = setup({
      shell: () =>
        ++call === 1
          ? { exitCode: 2, output: "boom", timedOut: false }
          : { exitCode: null, output: "", timedOut: true },
    });
    define({ name: "Check", trigger: { kind: "status_change", to: "review" }, action: shell() });
    const a = task("A");
    s.tasks.move(a.id, { status: "review" }, "agent");
    await pass();
    const b = task("B");
    s.tasks.move(b.id, { status: "review" }, "agent");
    await pass();
    const [timedOut, exited] = runsOf();
    expect(exited).toMatchObject({ status: "failed", exitCode: 2, detail: "boom", needsAttention: true });
    expect(timedOut).toMatchObject({ status: "failed", exitCode: null, needsAttention: true });
    expect(timedOut!.error).toMatch(/didn't finish within 30 seconds/);
    expect(s.tasks.summary(a.id).attention.map((r) => r.kind)).toContain("autopilot");
    expect(s.notifications.list().items.filter((n) => n.kind === "autopilot_failed")).toHaveLength(2);
  });

  it("records the filled prompt or the command in a dry run, and runs nothing", async () => {
    const { s, task, define, pass, runsOf, shellRuns, agentRuns } = setup();
    s.autopilot.updateEngine({ dryRun: true });
    define({
      name: "Agent",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "agent", prompt: "Look at {{task.title}}" },
    });
    define({
      name: "Shell",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "shell", command: "make check", timeoutSeconds: 5 },
    });
    const t = task("Dry");
    s.tasks.move(t.id, { status: "review" }, "agent");
    await pass();
    expect(shellRuns).toHaveLength(0);
    expect(agentRuns).toHaveLength(0);
    const runs = runsOf();
    expect(runs.every((r) => r.dryRun && r.status === "skipped")).toBe(true);
    const agent = runs.find((r) => r.summary.startsWith("Would start an agent"))!;
    expect(agent.detail).toContain("Look at Dry");
    const shellRun = runs.find((r) => r.summary.startsWith("Would run"))!;
    expect(shellRun.detail).toContain("make check");
    expect(shellRun.detail).toContain(`${brandEnv("TASK_TITLE")}="Dry"`);
  });
});

describe("custom automations: definitions", () => {
  it("refuses definitions that can't run", () => {
    const { s, project } = setup();
    const schedule = { kind: "schedule" as const, schedule: { kind: "hourly" as const, everyHours: 2 } };
    expect(() =>
      s.customAutomations.create({ name: "A", trigger: schedule, action: { kind: "agent", prompt: "x" } }),
    ).toThrow(/no task for an agent/);
    expect(() =>
      s.customAutomations.create({
        name: "B",
        trigger: schedule,
        filters: { labels: ["ui"] },
        action: { kind: "shell", command: "x" },
      }),
    ).toThrow(/only filter by project/);
    expect(() =>
      s.customAutomations.create({
        name: "C",
        trigger: { kind: "stale", hours: 2 },
        action: { kind: "shell", command: "echo {{task.title}}" },
      }),
    ).toThrow(new RegExp(`read the ${brandEnv("TASK_TITLE")} environment variable`));
    expect(() =>
      s.customAutomations.create({
        name: "D",
        trigger: { kind: "stale", hours: 2 },
        action: { kind: "agent", prompt: "{{task.body}}" },
      }),
    ).toThrow(/isn't a placeholder/);
    expect(() =>
      s.customAutomations.create({
        name: "E",
        trigger: { kind: "stale", hours: 2 },
        filters: { epicId: project.id },
        action: { kind: "shell", command: "x" },
      }),
    ).toThrow(/Epic not found/);
    s.customAutomations.create({
      name: "Taken",
      trigger: { kind: "stale", hours: 2 },
      action: { kind: "shell", command: "x" },
    });
    expect(() =>
      s.customAutomations.create({
        name: "taken",
        trigger: { kind: "stale", hours: 2 },
        action: { kind: "shell", command: "x" },
      }),
    ).toThrow(/already a custom automation/);
  });

  it("appears in the catalogue, and takes its switches with it when deleted", () => {
    const { s } = setup();
    const custom = s.customAutomations.create({
      name: "Ping",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "agent", prompt: "Go" },
    });
    const key = customAutomationKey(custom.id);
    const entry = s.autopilot.overview().automations.find((a) => a.key === key);
    expect(entry).toMatchObject({
      title: "Ping",
      needsAgent: true,
      description: "When a task moves into Review: start an agent.",
    });
    expect(entry!.fields.map((f) => f.key)).toContain("budgetUsd");
    s.autopilot.setScope("board", null, key, { mode: "on", config: { budgetUsd: 2 } });
    expect(s.autopilot.scope("board", null).find((e) => e.automation === key)).toMatchObject({ enabled: true });
    s.customAutomations.delete(custom.id);
    expect(s.autopilot.overview().automations.find((a) => a.key === key)).toBeUndefined();
    expect(s.autopilot.scope("board", null).find((e) => e.automation === key)).toBeUndefined();
  });

  it("arms again when the filters change", async () => {
    const { s, project } = setup();
    const custom = s.customAutomations.create({
      name: "Ping",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "shell", command: "x" },
    });
    await new Promise((r) => setTimeout(r, 5));
    const widened = s.customAutomations.update(custom.id, { filters: { projectIds: [project.id] } });
    expect(widened.armedAt > custom.armedAt).toBe(true);
  });

  it("arms again when the trigger changes, not when only the name does", async () => {
    const { s } = setup();
    const custom = s.customAutomations.create({
      name: "Ping",
      trigger: { kind: "status_change", to: "review" },
      action: { kind: "shell", command: "x" },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(s.customAutomations.update(custom.id, { name: "Pong" }).armedAt).toBe(custom.armedAt);
    expect(
      s.customAutomations.update(custom.id, { trigger: { kind: "status_change", to: "done" } }).armedAt >
        custom.armedAt,
    ).toBe(true);
  });
});

describe("custom automations: REST", () => {
  const origin = { origin: "http://127.0.0.1:5317" };
  const body = {
    name: "Ping",
    trigger: { kind: "status_change", to: "review" },
    action: { kind: "shell", command: "make" },
  };

  it("lists, creates, edits and deletes", async () => {
    const { request } = setup();
    const created = await request("/api/autopilot/custom", { method: "POST", json: body, headers: origin });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const edited = await request(`/api/autopilot/custom/${id}`, {
      method: "PATCH",
      json: { name: "Pong" },
      headers: origin,
    });
    expect(await edited.json()).toMatchObject({ name: "Pong" });
    expect(await (await request("/api/autopilot/custom")).json()).toHaveLength(1);
    expect((await request(`/api/autopilot/custom/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await request("/api/autopilot/custom")).json()).toHaveLength(0);
  });

  it("only takes a shell command from the board's page", async () => {
    const { request } = setup();
    const refused = await request("/api/autopilot/custom", { method: "POST", json: body });
    expect(refused.status).toBe(400);
    const agent = await request("/api/autopilot/custom", {
      method: "POST",
      json: { ...body, name: "Agent", action: { kind: "agent", prompt: "Go" } },
    });
    expect(agent.status).toBe(201);
    const { id } = (await agent.json()) as { id: string };
    const toShell = await request(`/api/autopilot/custom/${id}`, { method: "PATCH", json: { action: body.action } });
    expect(toShell.status).toBe(400);
  });

  it("switches per scope through the usual Autopilot routes", async () => {
    const { request, s } = setup();
    const custom = s.customAutomations.create({
      name: "Ping",
      trigger: { kind: "stale", hours: 3 },
      action: { kind: "agent", prompt: "Go" },
    });
    const key = encodeURIComponent(customAutomationKey(custom.id));
    const res = await request(`/api/autopilot/board/${key}`, { method: "PUT", json: { mode: "on" } });
    expect(res.status).toBe(200);
    expect(
      s.autopilot.resolve(
        s.autopilot.automations().find((a) => a.title === "Ping")!,
        null,
      ).enabled,
    ).toBe(true);
  });
});
