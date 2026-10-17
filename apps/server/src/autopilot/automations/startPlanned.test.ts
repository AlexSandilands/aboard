import type { AutopilotRun } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { NO_GITHUB, RunAbandonedError, type Runner, type RunnerRequest } from "../types.ts";
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
  /** The runner rejects with this once the agent has done its thing. */
  fail?: string;
  /** The runner gave up waiting for T3 Code because its `stillWanted` said no. */
  abandon?: boolean;
  /** Which runner it is, and so what it records: a thread, or a worktree and a session. */
  headless?: boolean;
}

function setup(opts: { now?: () => Date; behaviour?: Behaviour } = {}) {
  const requests: RunnerRequest[] = [];
  let threads = 0;
  const behaviour: Behaviour = opts.behaviour ?? {};
  const h = createTestHarness({ integrations: { automations: [startPlanned] } });
  const s = h.services;
  const runner: Runner = {
    start: (request, update = () => {}) => {
      requests.push(request);
      const taskId = request.run.taskId!;
      if (behaviour.abandon) {
        // A task started by hand while the runner waited for T3 Code.
        s.tasks.move(taskId, { status: "in_progress" }, "user");
        return request.stillWanted?.() === false
          ? Promise.reject(new RunAbandonedError("it changed while waiting for T3 Code"))
          : Promise.reject(new Error("stillWanted should say no once the task moved"));
      }
      const patch = behaviour.headless
        ? ({ runner: "headless", worktreePath: "/wt/1", sessionId: "s-1" } as const)
        : behaviour.fail
          ? ({ runner: "t3" } as const)
          : ({
              runner: "t3",
              threadUrl: s.links.add(
                taskId,
                { t3Thread: { environmentId: "env-1", threadId: `thread-${++threads}` } },
                "autopilot",
              ).url,
            } as const);
      update(patch);
      if (behaviour.onStart) behaviour.onStart(request, taskId);
      else if (!behaviour.fail || behaviour.headless) s.tasks.move(taskId, { status: "in_progress" }, "agent");
      if (behaviour.fail) return Promise.reject(new Error(behaviour.fail));
      return Promise.resolve({ ...patch, result: null });
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
  /** What T3's poll would report for the task's thread. */
  const thread = (
    taskId: string,
    status: "working" | "waiting" | "input" | "approval" | "idle" | "done",
    flags: { archived?: boolean; settled?: boolean } = {},
  ) => {
    const link = s.tasks.detail(taskId).links.find((l) => l.kind === "t3_thread")!;
    s.links.setSnapshot(link.id, { title: "T", status, ...flags, lastActivityAt: new Date().toISOString() });
  };
  const runs = (): AutopilotRun[] => s.autopilot.runsForProject(project.id);
  const turnOn = (config?: Record<string, unknown>) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_START_PLANNED, { mode: "on", ...(config ? { config } : {}) });
  return { ...h, s, behaviour, requests, engine, project, task, pass, runs, turnOn, thread };
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
    expect(request.label).toBe(`Start planned · #${t.number}`);
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
    const { s, task, engine, pass, requests, turnOn, thread } = setup();
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
    // Both threads are still working (as far as T3 has said): no room yet.
    await pass();
    expect(requests).toHaveLength(2);
    thread(c.id, "idle");
    await pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([c.id, a.id, b.id]);
  });
});

describe("start planned tasks: waiting for T3 Code", () => {
  it("tells the runner to stop waiting once the task isn't startable, and then skips the run instead of flagging it", async () => {
    const { task, pass, runs, requests, behaviour, turnOn } = setup();
    behaviour.abandon = true;
    const t = task("Started by hand");
    turnOn();
    await pass();
    expect(requests).toHaveLength(1);
    expect(runs()).toMatchObject([
      {
        taskId: t.id,
        status: "skipped",
        needsAttention: false,
        summary: `Skipped #${t.number}: it changed while waiting for T3 Code`,
      },
    ]);
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

  it("holds the next task while the first one's T3 thread is still working, and frees the slot when it goes idle", async () => {
    const { s, task, pass, requests, turnOn, thread } = setup();
    const a = task("A");
    const b = task("B");
    turnOn();
    await pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([a.id]);
    expect(s.tasks.summary(a.id).status).toBe("in_progress");
    // The run is over (the thread started), but T3's poll hasn't reported on the thread yet: it still counts.
    await pass();
    for (const status of ["working", "waiting", "input", "approval"] as const) {
      thread(a.id, status);
      await pass();
      expect(requests).toHaveLength(1);
    }
    thread(a.id, "idle");
    await pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([a.id, b.id]);
  });

  it("frees the slot when the thread is archived or settled, or the task is Done, but not while it is in Review", async () => {
    const { s, task, pass, requests, turnOn, thread } = setup();
    const a = task("A");
    task("B");
    task("C");
    task("D");
    turnOn();
    await pass();
    thread(a.id, "working", { archived: true });
    await pass();
    expect(requests).toHaveLength(2);
    // B's agent is working. Moving the task to Review doesn't free the slot: the agent runs its review loop there.
    const b = requests[1]!.run.taskId!;
    thread(b, "input", { settled: true });
    await pass();
    expect(requests).toHaveLength(3);
    const c = requests[2]!.run.taskId!;
    thread(c, "working");
    s.tasks.move(c, { status: "review" }, "agent");
    await pass();
    expect(requests).toHaveLength(3);
    s.tasks.move(c, { status: "done" }, "agent");
    await pass();
    expect(requests).toHaveLength(4);
  });

  it("doesn't let a failed task at the top of Planned use up the room of the tasks below it", async () => {
    const { s, task, pass, requests, runs, turnOn, behaviour } = setup({ behaviour: { fail: "T3 isn't connected" } });
    const a = task("A");
    const b = task("B");
    turnOn();
    await pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([a.id]);
    delete behaviour.fail;
    await pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([a.id, b.id]);
    expect(runs().filter((r) => r.status === "failed")).toHaveLength(1);
    expect(s.tasks.summary(b.id).status).toBe("in_progress");
  });

  it("doesn't count a task still in its grace period twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { s, task, engine, requests, turnOn, behaviour } = setup();
    const a = task("A");
    const b = task("B");
    turnOn();
    // A's agent hasn't moved it yet: its run is going and it is still in Planned, at the top of the column.
    behaviour.onStart = () => {};
    await engine.pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([a.id]);
    s.autopilot.updateEngine({ maxConcurrent: 2 });
    await engine.pass();
    expect(requests.map((r) => r.run.taskId)).toEqual([a.id, b.id]);
  });

  it("still counts a thread whose agent moved the task after the grace period ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { s, task, engine, requests, runs, turnOn, behaviour, thread } = setup();
    const a = task("A");
    task("B");
    turnOn({ graceMinutes: 1 });
    behaviour.onStart = () => {};
    const first = engine.pass();
    await vi.advanceTimersByTimeAsync(60_000 + START_POLL_MS);
    await first;
    await engine.idle();
    expect(runs()).toMatchObject([{ status: "failed" }]);
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    thread(a.id, "working");
    await engine.pass();
    expect(requests).toHaveLength(1);
  });

  it("doesn't take the launch-time poll's idle thread for a finished agent", async () => {
    const { s, task, pass, requests, turnOn, behaviour } = setup();
    task("A");
    task("B");
    turnOn();
    // T3's poll right after the launch finds a thread that hasn't run yet, before the agent has moved the task.
    behaviour.onStart = (_request, id) => {
      const link = s.tasks.detail(id).links.findLast((l) => l.kind === "t3_thread")!;
      s.links.setSnapshot(link.id, { title: "T", status: "idle", lastActivityAt: new Date().toISOString() });
      // The agent takes a moment: the run ends after the snapshot was taken.
      for (const start = Date.now(); Date.now() - start < 5;);
      s.tasks.move(id, { status: "in_progress" }, "agent");
    };
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
  });

  it("holds the cap for a thread that is waiting for approval before it has moved its task", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const { s, task, engine, requests, runs, turnOn, behaviour, thread } = setup();
    const a = task("A");
    task("B");
    turnOn({ graceMinutes: 1 });
    behaviour.onStart = () => {};
    const first = engine.pass();
    await vi.advanceTimersByTimeAsync(60_000 + START_POLL_MS);
    await first;
    await engine.idle();
    expect(runs()).toMatchObject([{ status: "failed" }]);
    expect(s.tasks.summary(a.id).status).toBe("planned");
    thread(a.id, "approval");
    await engine.pass();
    expect(requests).toHaveLength(1);
    thread(a.id, "idle");
    await engine.pass();
    expect(requests).toHaveLength(2);
  });

  it("stops counting a thread whose snapshot T3 stopped refreshing", async () => {
    let later = 0;
    const { task, pass, requests, turnOn, thread } = setup({ now: () => new Date(Date.now() + later) });
    const a = task("A");
    task("B");
    turnOn();
    await pass();
    thread(a.id, "working");
    later = 5 * 60_000;
    await pass();
    expect(requests).toHaveLength(1);
    later = 11 * 60_000;
    await pass();
    expect(requests).toHaveLength(2);
  });

  it("stops counting a thread T3 never reported on after ten minutes", async () => {
    let later = 0;
    const { task, pass, requests, turnOn } = setup({ now: () => new Date(Date.now() + later) });
    task("A");
    task("B");
    turnOn();
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
    later = 11 * 60_000;
    await pass();
    expect(requests).toHaveLength(2);
  });

  it("counts a larger cap's working threads, and ignores the cap in a dry run", async () => {
    const { s, task, pass, requests, runs, turnOn, thread } = setup();
    const a = task("A");
    task("B");
    task("C");
    turnOn();
    s.autopilot.updateEngine({ maxConcurrent: 2 });
    await pass();
    // Both slots go at once: the fake agents start and move their tasks within the pass.
    expect(requests).toHaveLength(2);
    thread(a.id, "working");
    await pass();
    expect(requests).toHaveLength(2);
    s.autopilot.updateEngine({ dryRun: true });
    await pass();
    expect(runs().filter((r) => r.dryRun)).toHaveLength(1);
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
    const { s, task, pass, requests, turnOn, behaviour, thread } = setup();
    const t = task("Flagged");
    behaviour.onStart = (_r, id) => {
      s.tasks.move(id, { status: "in_progress" }, "agent");
    };
    turnOn();
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
    // Its thread finished; the user sends the task back to Planned.
    thread(t.id, "idle");
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

  it("keeps what the runner recorded on a failed start", async () => {
    const { task, pass, runs, turnOn } = setup({ behaviour: { fail: "no worktree today", headless: true } });
    // The agent moves the task before it stops, as a headless run that hit its budget does.
    task("Flagged");
    turnOn();
    await pass();
    expect(runs()).toMatchObject([
      {
        status: "failed",
        needsAttention: true,
        runner: "headless",
        worktreePath: "/wt/1",
        sessionId: "s-1",
        error: "Autopilot's agent stopped before finishing: no worktree today",
      },
    ]);
  });

  it("says it couldn't start a task whose agent never began", async () => {
    const { task, pass, runs, turnOn } = setup({
      behaviour: { fail: "no worktree today", headless: true, onStart: () => {} },
    });
    task("Flagged");
    turnOn();
    await pass();
    expect(runs()).toMatchObject([
      { status: "failed", worktreePath: "/wt/1", error: "Autopilot couldn't start this task: no worktree today" },
    ]);
  });

  it("fails a headless run that ended with the task still in Planned without waiting out the grace period", async () => {
    const { task, pass, runs, turnOn } = setup({ behaviour: { headless: true, onStart: () => {} } });
    const t = task("Flagged");
    turnOn();
    // No fake timers: the run ends at once, or the test times out waiting.
    await pass();
    expect(runs()).toMatchObject([
      {
        status: "failed",
        needsAttention: true,
        runner: "headless",
        error: `Autopilot couldn't start this task: the agent didn't move #${t.number} out of Planned within 15 minutes`,
      },
    ]);
  });

  it("says a headless run started the task in its summary", async () => {
    const { task, pass, runs, turnOn } = setup({ behaviour: { headless: true } });
    const t = task("Flagged");
    turnOn();
    await pass();
    expect(runs()).toMatchObject([
      { status: "succeeded", summary: `Started #${t.number} headless`, worktreePath: "/wt/1" },
    ]);
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
        threadUrl: expect.stringContaining("thread-1"),
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
      github: NO_GITHUB,
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
