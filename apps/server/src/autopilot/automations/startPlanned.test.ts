import type { AutopilotRun } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { Runner, RunnerRequest } from "../types.ts";
import { AUTOPILOT_START_PLANNED, START_POLL_MS, startPlanned } from "./startPlanned.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

interface Behaviour {
  /** What the fake agent does once it is started: by default it moves the task to In Progress, as a real one does. */
  onStart?: (request: RunnerRequest, taskId: string) => void;
  fail?: string;
}

function setup(opts: { now?: () => Date; behaviour?: Behaviour } = {}) {
  const requests: RunnerRequest[] = [];
  const behaviour: Behaviour = opts.behaviour ?? {};
  const h = createTestHarness({ integrations: { automations: [startPlanned] } });
  const s = h.services;
  const runner: Runner = {
    start: (request, update = () => {}) => {
      requests.push(request);
      if (behaviour.fail) return Promise.reject(new Error(behaviour.fail));
      update({ runner: "t3", threadUrl: "t3code://threads/x" });
      const taskId = request.run.taskId!;
      if (behaviour.onStart) behaviour.onStart(request, taskId);
      else s.tasks.move(taskId, { status: "in_progress" }, "agent");
      return Promise.resolve({ runner: "t3", threadUrl: "t3code://threads/x", result: null });
    },
  };
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    boardUrl: () => "http://127.0.0.1:5317",
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
    ...(opts.now ? { now: opts.now } : {}),
  });
  engines.push(engine);
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = (title: string, extra: { autopilot?: boolean | null; blockedBy?: string[]; noPlan?: boolean } = {}) =>
    s.tasks.create({
      projectId: project.id,
      title,
      ...(extra.noPlan ? {} : { plan }),
      autopilot: extra.autopilot === undefined ? true : extra.autopilot,
      blockedBy: extra.blockedBy ?? [],
    });
  const pass = async () => {
    await engine.pass();
    await engine.idle();
  };
  const runs = (): AutopilotRun[] => s.autopilot.runsForProject(project.id);
  const turnOn = (config?: Record<string, unknown>) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_START_PLANNED, { mode: "on", ...(config ? { config } : {}) });
  return { ...h, s, behaviour, requests, engine, project, task, pass, runs, turnOn };
}

describe("start planned tasks: eligibility", () => {
  it("starts a flagged Planned task with a plan, with the work hand-off prompt and the task's tier", async () => {
    const { s, task, pass, runs, requests, turnOn } = setup();
    const t = task("Flagged");
    s.tasks.update(t.id, { suggestedModel: { tier: "deep", reason: "risky" } }, "user");
    turnOn();
    await pass();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.tier).toBe("deep");
    expect(request.prompt).toContain(`Let's work on #${t.number} "Flagged"`);
    expect(request.prompt).toContain(`get_task("${t.id}")`);
    expect(request.prompt).toContain("http://127.0.0.1:5317/?task=");
    expect(request.prompt).toContain("nobody is watching");
    expect(request.workspace).toBeUndefined();
    expect(runs()).toMatchObject([
      { taskId: t.id, status: "succeeded", needsAttention: false, summary: `Started #${t.number} in T3 Code` },
    ]);
  });

  it("leaves tasks flagged Default or Off, without a plan, blocked, archived, in another status, and epics", async () => {
    const { s, task, pass, runs, turnOn, project } = setup();
    task("Default", { autopilot: null });
    task("Off", { autopilot: false });
    task("No plan", { noPlan: true });
    const blocker = task("Blocker", { autopilot: false });
    task("Blocked", { blockedBy: [blocker.id] });
    const archived = task("Archived");
    s.tasks.update(archived.id, { archived: true }, "user");
    const inProgress = task("In progress");
    s.tasks.move(inProgress.id, { status: "in_progress" }, "agent");
    s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    turnOn();
    await pass();
    expect(runs()).toEqual([]);
  });

  it("starts a task once its last blocker is Done", async () => {
    const { s, task, pass, runs, turnOn } = setup();
    const blocker = task("Blocker", { autopilot: false });
    const dependent = task("Dependent", { blockedBy: [blocker.id] });
    turnOn();
    await pass();
    expect(runs()).toEqual([]);
    s.tasks.move(blocker.id, { status: "done" }, "agent");
    await pass();
    expect(runs()).toMatchObject([{ taskId: dependent.id, status: "succeeded" }]);
  });

  it("does nothing while the automation is off, which is the default", async () => {
    const { task, pass, runs } = setup();
    task("Flagged");
    await pass();
    expect(runs()).toEqual([]);
  });

  it("starts tasks in board order, as many as the cap allows", async () => {
    const { s, task, engine, pass, requests, turnOn } = setup();
    const a = task("A");
    const b = task("B");
    const c = task("C");
    // Drag C to the top of Planned.
    s.tasks.move(c.id, { status: "planned", beforeId: a.id }, "user");
    turnOn();
    s.autopilot.updateEngine({ maxConcurrent: 2 });
    await engine.pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([c.id, a.id]);
    await engine.idle();
    await pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([c.id, a.id, b.id]);
  });
});

describe("start planned tasks: limits", () => {
  it("waits out quiet hours", async () => {
    let clock = new Date();
    clock.setHours(23, 0, 0, 0);
    const { s, task, pass, requests, turnOn } = setup({ now: () => clock });
    task("A");
    turnOn();
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    await pass();
    expect(requests).toHaveLength(0);
    clock = new Date(clock);
    clock.setHours(12);
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("holds the next task while an agent run is going", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { task, engine, requests, turnOn, behaviour } = setup();
    // A slow agent: it leaves the task in Planned while it works, so the run stays active.
    behaviour.onStart = () => {};
    task("A");
    task("B");
    turnOn();
    await engine.pass();
    expect(requests).toHaveLength(1);
    await engine.pass();
    expect(requests).toHaveLength(1);
  });

  it("previews instead of starting in dry-run, and starts once dry-run is off", async () => {
    const { s, task, pass, runs, requests, turnOn } = setup();
    const t = task("Flagged");
    turnOn();
    s.autopilot.updateEngine({ dryRun: true });
    await pass();
    expect(requests).toEqual([]);
    expect(runs()).toMatchObject([{ status: "skipped", dryRun: true, summary: `Would start #${t.number} "Flagged"` }]);
    s.autopilot.updateEngine({ dryRun: false });
    await pass();
    expect(requests).toHaveLength(1);
  });
});

describe("start planned tasks: one attempt per entry into Planned", () => {
  it("doesn't start a task again once it has a run, but does when it re-enters Planned", async () => {
    const { s, task, pass, requests, turnOn, behaviour } = setup();
    const t = task("Flagged");
    behaviour.onStart = (_r, id) => {
      s.tasks.move(id, { status: "in_progress" }, "agent");
    };
    turnOn();
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
    s.tasks.move(t.id, { status: "planned" }, "user");
    await pass();
    expect(requests).toHaveLength(2);
  });

  it("never retries a failed start, flags the task and notifies, until the task re-enters Planned", async () => {
    const { s, task, pass, runs, requests, turnOn, behaviour } = setup({ behaviour: { fail: "T3 isn't connected" } });
    const t = task("Flagged");
    turnOn();
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
    expect(runs()).toMatchObject([
      {
        status: "failed",
        needsAttention: true,
        error: "Autopilot couldn't start this task: T3 isn't connected",
      },
    ]);
    expect(s.tasks.summary(t.id).attention).toContainEqual({
      kind: "autopilot",
      severity: "warning",
      message: "Autopilot couldn't start this task: T3 isn't connected",
    });
    expect(s.notifications.list().items.filter((n) => n.taskId === t.id)).toHaveLength(1);

    // Moving it out clears the flag; moving it back in is a new entry, so it is tried again.
    s.tasks.move(t.id, { status: "backlog" }, "user");
    expect(s.tasks.summary(t.id).attention.map((a) => a.kind)).not.toContain("autopilot");
    delete behaviour.fail;
    s.tasks.move(t.id, { status: "planned" }, "user");
    await pass();
    expect(requests).toHaveLength(2);
    expect(s.tasks.summary(t.id).status).toBe("in_progress");
  });

  it("flags a task the agent left in Planned past the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { s, task, engine, runs, turnOn, behaviour } = setup();
    const t = task("Flagged");
    behaviour.onStart = () => {};
    turnOn({ graceMinutes: 2 });
    const pass = engine.pass();
    await vi.advanceTimersByTimeAsync(0);
    await pass;
    expect(runs()).toMatchObject([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs()).toMatchObject([{ status: "running" }]);
    await vi.advanceTimersByTimeAsync(60_000 + START_POLL_MS);
    await engine.idle();
    expect(runs()).toMatchObject([
      {
        status: "failed",
        needsAttention: true,
        threadUrl: "t3code://threads/x",
        error:
          "Autopilot couldn't start this task: the agent didn't move #" + t.number + " out of Planned within 2 minutes",
      },
    ]);
    expect(s.tasks.summary(t.id).attention.map((a) => a.kind)).toContain("autopilot");
  });

  it("succeeds when the agent moves the task during the grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { s, task, engine, runs, turnOn, behaviour } = setup();
    const t = task("Flagged");
    behaviour.onStart = () => {};
    turnOn();
    const pass = engine.pass();
    await vi.advanceTimersByTimeAsync(0);
    await pass;
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 3);
    s.tasks.move(t.id, { status: "in_progress" }, "agent");
    await vi.advanceTimersByTimeAsync(START_POLL_MS);
    await engine.idle();
    expect(runs()).toMatchObject([{ status: "succeeded", needsAttention: false }]);
  });

  it("starts from the configured branch and tells the agent which skill to follow", async () => {
    const { task, pass, requests, turnOn } = setup();
    task("Flagged");
    turnOn({
      baseRef: "feat/autopilot",
      skill: { source: "global", name: "implement", path: "/home/u/.claude/skills/implement/SKILL.md" },
    });
    await pass();
    expect(requests[0]?.workspace).toEqual({ baseRef: "feat/autopilot" });
    expect(requests[0]?.prompt).toContain('read the skill "implement" at /home/u/.claude/skills/implement/SKILL.md');
  });
});

describe("start planned tasks: skipped when no longer eligible", () => {
  it("skips a task whose flag was switched off between the check and the action", async () => {
    const { s, task } = setup();
    const t = task("Flagged");
    const [candidate] = await startPlanned.check({
      services: s,
      engine: s.autopilot.engine(),
      now: new Date(),
      projects: s.projects.list().map((project) => ({ project, config: startPlanned.defaults })),
      board: null,
    });
    s.tasks.update(t.id, { autopilot: false }, "user");
    const result = await startPlanned.act(candidate!, {
      services: s,
      runner: { start: () => Promise.reject(new Error("must not run")) },
      engine: s.autopilot.engine(),
      boardUrl: "http://127.0.0.1:5317",
      config: startPlanned.defaults,
      run: { taskId: t.id } as AutopilotRun,
      actor: "autopilot",
      update: () => {},
    });
    expect(result).toMatchObject({ status: "skipped" });
  });
});
