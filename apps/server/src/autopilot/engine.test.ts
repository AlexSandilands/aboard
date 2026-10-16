import type { AutopilotRun, PlanInput } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestHarness } from "../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "./engine.ts";
import {
  defineAutomation,
  type Candidate,
  type CheckContext,
  type Runner,
  type RunnerResult,
  type RunPatch,
} from "./types.ts";

const plan: PlanInput = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };

/** One candidate per Planned task (not an epic, which rolls up from its tasks) in the projects where the automation is on. */
const plannedCandidates = (key: string, { services, projects }: CheckContext<unknown>): Candidate[] =>
  projects.flatMap(({ project }) =>
    services.tasks
      .summaries({ projectId: project.id, status: "planned" })
      .filter((t) => t.kind !== "epic")
      .map((t) => ({ dedupeKey: `${key}:${t.id}`, summary: `touch #${t.number}`, taskId: t.id })),
  );

interface Deferred {
  run: AutopilotRun;
  resolve(patch: RunPatch): void;
  reject(error: Error): void;
  /** What the engine gave the runner to record details while the run goes. */
  update: (patch: RunPatch) => void;
}

function setup(opts: { now?: () => Date; runEnded?: (run: AutopilotRun) => void } = {}) {
  let checks = 0;
  const noop = defineAutomation({
    key: "noop",
    title: "No-op",
    description: "Labels Planned tasks.",
    needsAgent: false,
    schema: z.object({ label: z.string() }),
    fields: [{ key: "label", label: "Label", kind: "text" }],
    defaults: { label: "touched" },
    check: (ctx) => {
      checks += 1;
      return plannedCandidates("noop", ctx);
    },
    act: (candidate, ctx) => {
      ctx.services.tasks.update(candidate.taskId!, { labels: [ctx.config.label] }, ctx.actor);
      return {};
    },
  });
  const agent = defineAutomation({
    key: "agent",
    title: "Agent",
    description: "Starts an agent on Planned tasks.",
    needsAgent: true,
    schema: z.object({}),
    fields: [],
    defaults: {},
    check: (ctx) => plannedCandidates("agent", ctx),
    act: async (_candidate, ctx) => {
      // What the runner recorded is the run's already; the action's own result is just how it went.
      const {
        result: _result,
        output: _output,
        ...patch
      } = await ctx.runner.start({
        run: ctx.run,
        prompt: "go",
        tier: null,
        options: ctx.config,
      });
      return patch;
    },
  });
  // Ignores its scopes and claims every Planned task is board-wide.
  const stray = defineAutomation({
    key: "stray",
    title: "Stray",
    description: "Returns more than it was asked for.",
    needsAgent: false,
    schema: z.object({}),
    fields: [],
    defaults: {},
    check: ({ services }) =>
      services.tasks
        .summaries({ status: "planned" })
        .map((t) => ({ dedupeKey: `stray:${t.id}`, summary: "stray", taskId: t.id, projectId: null })),
    act: () => ({}),
  });
  // Like Recurring tasks: one candidate per project, with no task.
  const projectWide = defineAutomation({
    key: "project_wide",
    title: "Project-wide",
    description: "Acts once per project.",
    needsAgent: false,
    schema: z.object({}),
    fields: [],
    defaults: {},
    check: ({ projects }) =>
      projects.map(({ project }) => ({
        dedupeKey: `project_wide:${project.id}`,
        summary: "act",
        projectId: project.id,
      })),
    act: () => ({}),
  });
  const started: Deferred[] = [];
  const runner: Runner = {
    start: ({ run }, update = () => {}) =>
      new Promise<RunnerResult>((resolve, reject) => {
        started.push({ run, resolve: (patch) => resolve({ ...patch, result: null }), reject, update });
      }),
  };
  const h = createTestHarness({ integrations: { automations: [noop, agent, stray, projectWide] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    debounceMs: 5,
    tickMs: 1_000_000,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.runEnded ? { runEnded: opts.runEnded } : {}),
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const task = s.tasks.create({ projectId: project.id, title: "One", plan });
  const runs = (automation?: string) =>
    [...s.autopilot.runsForProject(project.id), ...s.autopilot.runsForProject(other.id)].filter(
      (r) => !automation || r.automation === automation,
    );
  return { ...h, s, engine, project, other, task, started, runs, checks: () => checks };
}

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

const settle = async (engine: AutopilotEngine) => {
  await engine.pass();
  await engine.idle();
};

describe("scopes", () => {
  it("runs nothing while every automation is off, which is the default", async () => {
    const { engine, runs, checks } = setup();
    await settle(engine);
    expect(runs()).toEqual([]);
    // An automation that is on nowhere isn't even checked.
    expect(checks()).toBe(0);
  });

  it("runs where the board turns it on, unless a project turns it off", async () => {
    const { s, engine, project, other, runs } = setup();
    const b = s.tasks.create({ projectId: other.id, title: "Two", plan });
    s.autopilot.setScope("board", null, "noop", { mode: "on" });
    s.autopilot.setScope("project", other.id, "noop", { mode: "off" });
    await settle(engine);
    expect(runs("noop").map((r) => r.projectId)).toEqual([project.id]);

    s.autopilot.setScope("project", other.id, "noop", { mode: "inherit" });
    await settle(engine);
    expect(runs("noop").map((r) => r.taskId)).toContain(b.id);
  });

  it("runs in a project switched on while the board is off, with that project's config", async () => {
    const { s, engine, task, runs } = setup();
    s.autopilot.setScope("board", null, "noop", { mode: "off", config: { label: "board" } });
    s.autopilot.setScope("project", task.projectId, "noop", { mode: "on", config: { label: "mine" } });
    await settle(engine);
    expect(runs("noop")).toHaveLength(1);
    expect(s.tasks.summary(task.id).labels).toEqual(["mine"]);
  });
});

describe("epic scope", () => {
  /** An epic holding one Planned task, next to the setup's loose task. */
  function withEpic() {
    const t = setup();
    const child = t.s.tasks.create({ projectId: t.project.id, title: "In the epic", plan });
    const epic = t.s.tasks.createEpic({ projectId: t.project.id, title: "Epic" }, [child.id], "agent");
    const ran = () => t.runs("noop").flatMap((r) => (r.taskId ? [r.taskId] : []));
    return { ...t, child, epic, ran };
  }

  it("switches an automation on for the epic's tasks only, while the project and board are off", async () => {
    const { s, engine, epic, child, task, ran } = withEpic();
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "on" }, epic.projectId);
    await settle(engine);
    expect(ran()).toEqual([child.id]);
    expect(ran()).not.toContain(task.id);
  });

  it("lets an epic switch an automation off for its tasks while the project is on", async () => {
    const { s, engine, epic, child, task, ran } = withEpic();
    s.autopilot.setScope("project", epic.projectId, "noop", { mode: "on" });
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "off" }, epic.projectId);
    await settle(engine);
    expect(ran()).toContain(task.id);
    expect(ran()).not.toContain(child.id);
  });

  it("follows the project, then the board, while the epic is on Inherit", async () => {
    const { s, engine, epic, child, ran } = withEpic();
    s.autopilot.setScope("board", null, "noop", { mode: "on" });
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "inherit" }, epic.projectId);
    await settle(engine);
    expect(ran()).toContain(child.id);
  });

  it("uses the epic's config over the project's for its tasks, and the project's for the rest", async () => {
    const { s, engine, epic, child, task } = withEpic();
    s.autopilot.setScope("project", epic.projectId, "noop", { mode: "on", config: { label: "project" } });
    s.autopilot.setScope("epic", epic.id, "noop", { config: { label: "epic" } }, epic.projectId);
    await settle(engine);
    expect(s.tasks.summary(child.id).labels).toEqual(["epic"]);
    expect(s.tasks.summary(task.id).labels).toEqual(["project"]);
  });

  it("stops counting an epic once it is archived, and counts it again when unarchived", () => {
    const { s, epic, child } = withEpic();
    const noop = s.autopilot.automations().find((a) => a.key === "noop")!;
    s.autopilot.setScope("project", epic.projectId, "noop", { mode: "on", config: { label: "project" } });
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "off", config: { label: "epic" } }, epic.projectId);
    const resolve = () => s.autopilot.resolve(noop, epic.projectId, epic.id);
    expect(resolve()).toEqual({ enabled: false, config: { label: "epic" } });

    // An epic can only be archived once its tasks are finished; the finished task then follows the project.
    s.tasks.move(child.id, { status: "done" }, "agent");
    s.tasks.update(epic.id, { archived: true }, "user");
    expect(resolve()).toEqual({ enabled: true, config: { label: "project" } });
    expect(s.autopilot.projectsWithEpicOn(noop).size).toBe(0);

    s.tasks.update(epic.id, { archived: false }, "user");
    expect(resolve()).toEqual({ enabled: false, config: { label: "epic" } });
  });

  it("looks at a project for an epic that is on, but not for one that is off or archived", () => {
    const { s, epic, child } = withEpic();
    const noop = s.autopilot.automations().find((a) => a.key === "noop")!;
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "off" }, epic.projectId);
    expect(s.autopilot.projectsWithEpicOn(noop).size).toBe(0);
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "on" }, epic.projectId);
    expect([...s.autopilot.projectsWithEpicOn(noop)]).toEqual([epic.projectId]);
    s.tasks.move(child.id, { status: "done" }, "agent");
    s.tasks.update(epic.id, { archived: true }, "user");
    expect(s.autopilot.projectsWithEpicOn(noop).size).toBe(0);
  });

  it("doesn't look at a project for an archived epic that is on, in a real pass", async () => {
    const { s, engine, epic, child, task, checks } = withEpic();
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "on" }, epic.projectId);
    s.tasks.move(child.id, { status: "done" }, "agent");
    s.tasks.update(epic.id, { archived: true }, "user");
    await settle(engine);
    expect(checks()).toBe(0);
    expect(s.tasks.summary(task.id).labels).toEqual([]);
  });

  it("never lets an epic switch on an automation that has no task, like Recurring tasks", async () => {
    const { s, engine, epic, runs } = withEpic();
    s.autopilot.setScope("epic", epic.id, "project_wide", { mode: "on" }, epic.projectId);
    await settle(engine);
    expect(runs("project_wide")).toEqual([]);

    // The project's own switch still works, and an epic's Off doesn't hold it back.
    s.autopilot.setScope("epic", epic.id, "project_wide", { mode: "off" }, epic.projectId);
    s.autopilot.setScope("project", epic.projectId, "project_wide", { mode: "on" });
    await settle(engine);
    expect(runs("project_wide")).toMatchObject([{ projectId: epic.projectId, taskId: null, status: "succeeded" }]);
  });

  it("ignores an epic from another project", () => {
    const { s, epic, other } = withEpic();
    const noop = s.autopilot.automations().find((a) => a.key === "noop")!;
    s.autopilot.setScope("epic", epic.id, "noop", { mode: "on" }, epic.projectId);
    expect(s.autopilot.resolve(noop, other.id, epic.id).enabled).toBe(false);
  });

  it("files a run under its epic until it ends, so the epic's button can spin", async () => {
    const { s, engine, epic, child, started } = withEpic();
    s.autopilot.setScope("epic", epic.id, "agent", { mode: "on" }, epic.projectId);
    await engine.pass();
    expect(s.autopilot.status().active).toMatchObject([{ taskId: child.id, epicId: epic.id }]);
    started[0]!.resolve({});
    await engine.idle();
    expect(s.autopilot.status().active).toEqual([]);
  });

  it("gives a loose task's run no epic", async () => {
    const { s, engine, task, started } = setup();
    s.autopilot.setScope("project", task.projectId, "agent", { mode: "on" });
    await engine.pass();
    expect(s.autopilot.status().active).toMatchObject([{ taskId: task.id, epicId: null }]);
    started[0]!.resolve({});
    await engine.idle();
  });
});

describe("candidates", () => {
  it("files a task's run under the task's project, so that project's Off switch holds", async () => {
    const { s, engine, task, other, runs } = setup();
    const b = s.tasks.create({ projectId: other.id, title: "Two", plan });
    s.autopilot.setScope("board", null, "stray", { mode: "on" });
    s.autopilot.setScope("project", task.projectId, "stray", { mode: "off" });
    await settle(engine);
    expect(runs("stray").map((r) => [r.taskId, r.projectId])).toEqual([[b.id, other.id]]);
  });
});

describe("runs", () => {
  it("records a run, acts, logs it under the autopilot actor and dedupes the next pass", async () => {
    const { s, engine, task, runs, events } = setup();
    s.autopilot.setScope("project", task.projectId, "noop", { mode: "on" });
    await settle(engine);
    const [run] = runs("noop");
    expect(run).toMatchObject({ status: "succeeded", taskId: task.id, dedupeKey: `noop:${task.id}`, dryRun: false });
    expect(s.tasks.summary(task.id).labels).toEqual(["touched"]);
    const activity = s.tasks.detail(task.id).events.filter((e) => e.type === "autopilot_run");
    expect(activity.map((e) => [e.actor, e.payload.status])).toEqual([
      ["autopilot", "running"],
      ["autopilot", "succeeded"],
    ]);
    expect(events.some((e) => e.type === "autopilot.changed")).toBe(true);

    await settle(engine);
    expect(runs("noop")).toHaveLength(1);
  });

  it("in dry-run records what it would do and nothing else, then runs for real once dry-run is off", async () => {
    const { s, engine, task, runs } = setup();
    s.autopilot.updateEngine({ dryRun: true });
    s.autopilot.setScope("project", task.projectId, "noop", { mode: "on" });
    await settle(engine);
    await settle(engine);
    expect(runs("noop")).toMatchObject([{ status: "skipped", dryRun: true, summary: `Would touch #${task.number}` }]);
    expect(s.tasks.summary(task.id).labels).toEqual([]);

    s.autopilot.updateEngine({ dryRun: false });
    await settle(engine);
    expect(
      runs("noop")
        .map((r) => r.status)
        .sort(),
    ).toEqual(["skipped", "succeeded"]);
  });

  it("starts nothing while paused, and lets a run already going finish", async () => {
    const { s, engine, task, runs, started } = setup();
    s.autopilot.setScope("project", task.projectId, "agent", { mode: "on" });
    await engine.pass();
    expect(runs("agent")).toMatchObject([{ status: "running" }]);

    expect(s.autopilot.setPaused(true)).toMatchObject({ paused: true, active: [{ status: "running" }] });
    s.tasks.create({ projectId: task.projectId, title: "Two", plan });
    s.autopilot.setScope("project", task.projectId, "noop", { mode: "on" });
    await engine.pass();
    started[0]!.resolve({ runner: "fake", costUsd: 0.5 });
    await engine.idle();
    expect(runs("agent")).toMatchObject([{ status: "succeeded", runner: "fake", costUsd: 0.5 }]);
    expect(runs("noop")).toEqual([]);

    s.autopilot.setPaused(false);
    await engine.pass();
    expect(runs("noop")).toHaveLength(2);
    started[1]!.resolve({});
    await engine.idle();
  });
});

describe("limits", () => {
  it("runs one agent at a time by default and picks the next up once it finishes", async () => {
    const { s, engine, task, runs, started } = setup();
    s.tasks.create({ projectId: task.projectId, title: "Two", plan });
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    await engine.pass();
    expect(runs("agent")).toHaveLength(1);
    expect(s.autopilot.status().active).toHaveLength(1);

    started[0]!.resolve({});
    await engine.idle();
    await engine.pass();
    expect(
      runs("agent")
        .map((r) => r.status)
        .sort(),
    ).toEqual(["running", "succeeded"]);
    started[1]!.resolve({});
    await engine.idle();
  });

  it("holds agent runs, but not other automations, in quiet hours", async () => {
    let clock = new Date();
    clock.setHours(23, 0, 0, 0);
    const { s, engine, task, runs, started } = setup({ now: () => clock });
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    s.autopilot.setScope("board", null, "noop", { mode: "on" });
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    await settle(engine);
    expect(runs("agent")).toEqual([]);
    expect(runs("noop")).toHaveLength(1);

    clock = new Date(clock);
    clock.setHours(12);
    await engine.pass();
    expect(runs("agent")).toMatchObject([{ taskId: task.id, status: "running" }]);
    started[0]!.resolve({});
    await engine.idle();

    // Quiet hours switched off: the window no longer applies.
    clock.setHours(23);
    s.tasks.create({ projectId: task.projectId, title: "Two", plan });
    s.autopilot.updateEngine({ quietHours: { enabled: false } });
    await engine.pass();
    expect(runs("agent")).toHaveLength(2);
    started[1]!.resolve({});
    await engine.idle();
  });

  it("stops starting agent runs at the daily run cap and the daily spend cap", async () => {
    const { s, engine, task, runs, started } = setup();
    s.tasks.create({ projectId: task.projectId, title: "Two", plan });
    s.autopilot.updateEngine({ maxConcurrent: 5, dailyRunCap: 1 });
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    await engine.pass();
    started[0]!.resolve({ costUsd: 3 });
    await engine.idle();
    await engine.pass();
    expect(runs("agent")).toHaveLength(1);

    s.autopilot.updateEngine({ dailyRunCap: null, dailySpendCapUsd: 3 });
    await engine.pass();
    expect(runs("agent")).toHaveLength(1);

    s.autopilot.updateEngine({ dailySpendCapUsd: 10 });
    await engine.pass();
    expect(runs("agent")).toHaveLength(2);
    started[1]!.resolve({});
    await engine.idle();
  });
});

describe("failures and attention", () => {
  it("records a run's outcome even when the listener for ended runs throws", async () => {
    const { s, engine, runs, started } = setup({
      runEnded: () => {
        throw new Error("listener broke");
      },
    });
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    await engine.pass();
    started[0]!.resolve({});
    await engine.idle();
    expect(runs("agent")).toMatchObject([{ status: "succeeded", error: null }]);
  });

  it("tells whoever is listening that a run ended, finished or failed, with its session", async () => {
    const ended: Array<[string, string | null]> = [];
    const { s, engine, task, runs, started } = setup({ runEnded: (run) => ended.push([run.status, run.sessionId]) });
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    await engine.pass();
    started[0]!.update({ runner: "headless", sessionId: "s-1" });
    expect(ended).toEqual([]);
    started[0]!.resolve({});
    await engine.idle();
    expect(ended).toEqual([["succeeded", "s-1"]]);

    s.tasks.create({ projectId: task.projectId, title: "Two", plan });
    await engine.pass();
    started[1]!.update({ runner: "headless", sessionId: "s-2" });
    started[1]!.reject(new Error("no runner today"));
    await engine.idle();
    expect(ended).toEqual([
      ["succeeded", "s-1"],
      ["failed", "s-2"],
    ]);
    expect(runs("agent")).toHaveLength(2);
  });

  it("fails a run whose action throws, flags the task, and clears the flag when the task moves", async () => {
    const { s, engine, task, runs, started } = setup();
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    await engine.pass();
    // What the runner recorded before failing stays on the run.
    started[0]!.update({ runner: "headless", sessionId: "s-1", worktreePath: "/wt/1" });
    expect(runs("agent")).toMatchObject([{ status: "running", sessionId: "s-1" }]);
    started[0]!.reject(new Error("no runner today"));
    await engine.idle();
    expect(runs("agent")).toMatchObject([
      { status: "failed", error: "no runner today", needsAttention: true, runner: "headless", worktreePath: "/wt/1" },
    ]);
    expect(s.tasks.summary(task.id).attention).toContainEqual({
      kind: "autopilot",
      severity: "warning",
      message: "no runner today",
    });

    // Not retried: the dedupe key already has a run.
    await settle(engine);
    expect(runs("agent")).toHaveLength(1);

    s.tasks.move(task.id, { status: "in_progress" }, "user");
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).not.toContain("autopilot");
  });

  it("clears the flag when a later run of the same automation succeeds, not another automation's", async () => {
    const { s, engine, task, started } = setup();
    s.autopilot.setScope("board", null, "agent", { mode: "on" });
    await engine.pass();
    started[0]!.reject(new Error("boom"));
    await engine.idle();
    const kinds = () => s.tasks.summary(task.id).attention.map((a) => a.kind);
    expect(kinds()).toContain("autopilot");

    s.autopilot.setScope("board", null, "noop", { mode: "on" });
    await settle(engine);
    expect(kinds()).toContain("autopilot");

    const again = s.autopilot.record({
      automation: "agent",
      candidate: { dedupeKey: "agent:again", summary: "start it", taskId: task.id, projectId: task.projectId },
      dryRun: false,
    })!;
    s.autopilot.start(again.id);
    s.autopilot.finish(again.id, {});
    expect(kinds()).not.toContain("autopilot");
  });

  it("fails and flags runs a restart left going", () => {
    const { s, task } = setup();
    const run = s.autopilot.record({
      automation: "agent",
      candidate: { dedupeKey: "k", summary: "start it", taskId: task.id, projectId: task.projectId },
      dryRun: false,
    })!;
    s.autopilot.start(run.id);
    expect(s.autopilot.recover()).toBe(1);
    expect(s.autopilot.runsForTask(task.id)).toMatchObject([{ status: "failed", needsAttention: true }]);
    expect(s.autopilot.status().active).toEqual([]);
    expect(s.autopilot.recover()).toBe(0);
  });
});

describe("events", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("passes after board changes, but not after changes it made itself", async () => {
    const { s, engine, task, checks } = setup();
    s.autopilot.setScope("board", null, "noop", { mode: "on" });
    engine.start();
    await wait(40);
    await engine.idle();
    expect(checks()).toBe(1);
    // The action relabelled the task; that change started no pass.
    expect(s.tasks.summary(task.id).labels).toEqual(["touched"]);
    await wait(40);
    expect(checks()).toBe(1);

    s.tasks.update(task.id, { title: "Renamed" }, "user");
    await wait(40);
    await engine.idle();
    expect(checks()).toBe(2);
  });
});
