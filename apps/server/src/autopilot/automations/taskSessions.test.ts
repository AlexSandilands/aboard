import { AUTOPILOT_ORCHESTRATE, canRetryRun, type PlanInput, type PrSnapshot } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepos } from "../../db/repos/index.ts";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { WorktreeHeadError, type RunnerRequest, type RunnerResult } from "../types.ts";
import { orchestrate } from "./orchestrate.ts";
import { AUTOPILOT_TASK_SESSIONS, taskSessions } from "./taskSessions.ts";

const plan: PlanInput = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const MINUTE = 60_000;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "Add the thing",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/thing",
  updatedAt: null,
  headOid: SHA,
  ...over,
});

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

function setup(opts: { agent?: (request: RunnerRequest) => Promise<RunnerResult> } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 17, 13, 44));
  const h = createTestHarness({ integrations: { automations: [orchestrate, taskSessions] } });
  const agentRuns: RunnerRequest[] = [];
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: {
      start: (request) => {
        agentRuns.push(request);
        return opts.agent ? opts.agent(request) : Promise.resolve({ runner: "headless", result: "done" });
      },
    },
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const task = s.tasks.create({ projectId: project.id, title: "Stalled", plan });
  s.tasks.move(task.id, { status: "in_progress" }, "agent");
  const ask = (taskId = task.id, note = "Answer the review threads and push.") =>
    s.taskSessions.request({ taskId, note, actor: "autopilot", projectId: s.tasks.summary(taskId).projectId });
  const pass = async () => {
    await engine.pass();
    await engine.idle();
  };
  // Orchestrate on, with a slot interval long enough that its own scheduled runs don't get in the way: the task is
  // In Progress, so Orchestrate would look it over too. Those runs are left out of `sessions()`.
  const on = (config: Record<string, unknown> = {}) =>
    s.autopilot.setScope("board", null, AUTOPILOT_ORCHESTRATE, {
      mode: "on",
      config: { everyMinutes: 1440, ...config },
    });
  const sessions = () => agentRuns.filter((r) => r.run.automation === AUTOPILOT_TASK_SESSIONS);
  const runs = () => s.autopilot.runsForTask(task.id).filter((r) => r.automation === AUTOPILOT_TASK_SESSIONS);
  return { ...h, s, engine, project, other, task, ask, pass, on, sessions, runs };
}

describe("Task sessions", () => {
  it("turns a request into one taskRun session with the hand-off prompt and Orchestrate's note", async () => {
    const { s, task, ask, pass, on, sessions, runs } = setup();
    on();
    const request = ask();
    await pass();
    await pass();
    expect(sessions()).toHaveLength(1);
    const started = sessions()[0]!;
    expect(started.operation).toBe("taskRun");
    // Only the runner choice: budget, timeout and model are the board's for task runs, not Orchestrate's own.
    expect(started.options).toEqual({ runner: "auto" });
    expect(started.label).toBe("Task sessions");
    expect(started.prompt).toContain(`Let's work on #${task.number} "Stalled"`);
    expect(started.prompt).toContain("<orchestrate-note>\nAnswer the review threads and push.\n</orchestrate-note>");
    expect(started.prompt).toContain("It is Orchestrate's, not the user's");
    expect(started.prompt).toContain("nobody is watching this session");
    // No PR: a new branch from the default branch, and a pointer to what earlier sessions left.
    expect(started.workspace).toBeUndefined();
    expect(started.prompt).toContain("read the task's notes, steps and activity (get_task) first");
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ status: "succeeded", summary: `Ran a headless session on #${task.number}` });
    expect(s.taskSessions.get(request.id)!.runId).toBe(runs()[0]!.id);
    // The request is noted on the task for whoever picks it up next.
    expect(s.tasks.detail(task.id).events.some((e) => e.type === "note")).toBe(true);
  });

  it("goes by Orchestrate's switch and its Sessions it starts: Runner setting, and has no switch of its own", async () => {
    const { s, project, ask, pass, on, sessions } = setup();
    ask();
    await pass();
    expect(sessions()).toEqual([]);
    expect(() => s.autopilot.setScope("board", null, AUTOPILOT_TASK_SESSIONS, { mode: "on" })).toThrow(
      /part of Orchestrate/,
    );
    on({ runner: "t3" });
    s.autopilot.setScope("project", project.id, AUTOPILOT_ORCHESTRATE, { mode: "on", config: { runner: "headless" } });
    await pass();
    expect(sessions().map((r) => r.options)).toEqual([{ runner: "headless" }]);
    // Not listed as an automation of its own, but named as Orchestrate's part.
    const overview = s.autopilot.overview();
    expect(overview.automations.map((a) => a.key)).not.toContain(AUTOPILOT_TASK_SESSIONS);
    expect(overview.parts).toEqual([expect.objectContaining({ key: AUTOPILOT_TASK_SESSIONS, partOf: "orchestrate" })]);
  });

  it("drops a request whose project Orchestrate is off in, and one that waited too long", async () => {
    const { s, other, ask, pass, on, sessions } = setup();
    on();
    s.autopilot.setScope("project", other.id, AUTOPILOT_ORCHESTRATE, { mode: "off" });
    const elsewhere = s.tasks.create({ projectId: other.id, title: "Elsewhere", plan });
    s.tasks.move(elsewhere.id, { status: "in_progress" }, "agent");
    const dropped = ask(elsewhere.id);
    await pass();
    expect(s.taskSessions.get(dropped.id)).toMatchObject({ droppedReason: "Orchestrate is off in its project" });
    // The task says so, for the next Orchestrate run that reads it.
    expect(s.tasks.detail(elsewhere.id).events.map((e) => e.payload.text)).toContain(
      "Autopilot dropped Orchestrate's request for a new session: Orchestrate is off in its project.",
    );

    s.autopilot.setPaused(true);
    const held = ask();
    await pass();
    vi.setSystemTime(Date.now() + 3 * 60 * MINUTE);
    s.autopilot.setPaused(false);
    await pass();
    expect(s.taskSessions.get(held.id)).toMatchObject({ droppedReason: "it waited too long for room to run" });
    expect(sessions()).toEqual([]);
  });

  it("is held by pause, quiet hours and the daily run cap, and starts once they lift", async () => {
    const { s, task, ask, pass, on, sessions } = setup();
    on();
    ask();
    s.autopilot.setPaused(true);
    await pass();
    expect(sessions()).toEqual([]);
    s.autopilot.setPaused(false);
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "13:00", end: "14:00" } });
    await pass();
    expect(sessions()).toEqual([]);
    // One agent run today already uses up a cap of one.
    s.autopilot.updateEngine({ quietHours: { enabled: false }, dailyRunCap: 1 });
    const used = s.autopilot.record({
      automation: AUTOPILOT_ORCHESTRATE,
      candidate: { dedupeKey: "used-up", summary: "look", projectId: s.tasks.summary(task.id).projectId },
      dryRun: false,
    })!;
    s.autopilot.start(used.id);
    s.autopilot.finish(used.id, {});
    await pass();
    expect(sessions()).toEqual([]);
    s.autopilot.updateEngine({ dailyRunCap: null });
    await pass();
    expect(sessions()).toHaveLength(1);
  });

  it("works on the open PR's branch at its head, and skips as deferred when the head moved", async () => {
    const { s, task, ask, pass, on, sessions, runs } = setup({
      agent: () => Promise.reject(new WorktreeHeadError("moved", "b".repeat(40), true)),
    });
    s.links.add(task.id, { value: "https://github.com/acme/app/pull/7" }, "agent");
    const link = s.tasks.summary(task.id).links.find((l) => l.kind === "pr")!;
    s.links.setSnapshot(link.id, pr());
    on();
    ask();
    await pass();
    expect(sessions()[0]).toMatchObject({ workspace: { branch: "feat/thing" }, expectHead: SHA });
    expect(sessions()[0]!.prompt).toContain("your worktree starts from its branch `feat/thing`");
    expect(runs()[0]).toMatchObject({ status: "skipped", deferred: "head_moved" });
    expect(s.tasks.detail(task.id).events.map((e) => e.payload.text)).toContain(
      "Autopilot skipped the session Orchestrate asked for: the pull request moved on before it started. Ask for a new one if the task is still stalled.",
    );
  });

  it("starts an integration epic's task from the epic's branch", async () => {
    const { s, project, ask, pass, on, sessions } = setup();
    const child = s.tasks.create({ projectId: project.id, title: "Form", plan });
    const epic = s.tasks.createEpic({ projectId: project.id, title: "Checkout" }, [child.id], "user");
    s.tasks.setDelivery(epic.id, "integration", "epic/9-checkout", "user");
    s.tasks.move(child.id, { status: "in_progress" }, "agent");
    on();
    ask(child.id);
    await pass();
    expect(sessions()[0]).toMatchObject({ workspace: { prBase: "epic/9-checkout" } });
  });

  it("skips a request whose task moved on while it waited", async () => {
    const { s, task, ask, pass, on, sessions, runs } = setup();
    on();
    ask();
    s.tasks.move(task.id, { status: "done" }, "user");
    await pass();
    expect(sessions()).toEqual([]);
    expect(runs()[0]).toMatchObject({ status: "skipped" });
    expect(runs()[0]!.summary).toContain("sessions start only on tasks In Progress or in Review");
  });

  it("fails a session that couldn't start, and runs the request again when the run is retried", async () => {
    let fail = true;
    const { s, ask, pass, on, sessions, runs } = setup({
      agent: () =>
        fail ? Promise.reject(new Error("CLI missing")) : Promise.resolve({ runner: "headless", result: "" }),
    });
    on();
    ask();
    await pass();
    expect(runs()[0]).toMatchObject({ status: "failed" });
    expect(runs()[0]!.error).toContain("CLI missing");
    fail = false;
    s.autopilot.retry(runs()[0]!.id, "orchestrator");
    await pass();
    expect(sessions()).toHaveLength(2);
    expect(runs().filter((r) => r.status === "succeeded")).toHaveLength(1);
  });

  it("drops a waiting request once a machine whose Autopilot looks after the task takes it", async () => {
    const { s, db, task, ask, pass, on, sessions } = setup();
    on();
    s.autopilot.setPaused(true);
    const request = ask();
    const machine = s.machines.add({
      instanceId: "engine-2",
      name: "engine",
      routes: [{ kind: "ssh", target: "me@engine", port: null, remotePort: 4318 }],
    });
    createRepos(db).holds.insert({
      taskId: task.id,
      machineId: machine.id,
      heldAt: new Date().toISOString(),
      afterLogId: 0,
    });
    s.autopilot.setPaused(false);
    await pass();
    expect(sessions()).toEqual([]);
    expect(s.taskSessions.get(request.id)!.droppedReason).toBe(
      `#${task.number} is now held by engine, whose own Autopilot looks after it`,
    );
  });

  it("refuses to retry a skipped session, in the service and in canRetryRun (the Retry buttons and the default pick)", async () => {
    const { s, task, ask, pass, on, runs } = setup();
    on();
    ask();
    s.tasks.move(task.id, { status: "done" }, "user");
    await pass();
    expect(runs()[0]).toMatchObject({ status: "skipped" });
    expect(() => s.autopilot.retry(runs()[0]!.id, "orchestrator")).toThrow(/nothing to retry/);
    // The Retry buttons and retry_autopilot_run's default pick go by canRetryRun, which agrees.
    expect(canRetryRun(runs()[0]!, runs())).toBe(false);
  });
});

describe("start_task_session's refusals", () => {
  it("refuses manual, Planned, blocked, busy and recently asked-for tasks, and other projects", () => {
    const { s, db, project, other, task, ask } = setup();
    const h = { db };
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message;
      }
      return null;
    };
    const planned = s.tasks.create({ projectId: project.id, title: "Planned", plan });
    s.tasks.move(planned.id, { status: "planned" }, "agent");
    expect(refused(() => ask(planned.id))).toMatch(/is in Planned, which Start planned starts/);

    const manual = s.tasks.create({ projectId: project.id, title: "Mine", manual: true });
    s.tasks.move(manual.id, { status: "in_progress" }, "user");
    expect(refused(() => ask(manual.id))).toMatch(/manual task/);

    const done = s.tasks.create({ projectId: project.id, title: "Done", plan });
    s.tasks.move(done.id, { status: "done" }, "agent");
    expect(refused(() => ask(done.id))).toMatch(/only on tasks In Progress or in Review/);

    const blocked = s.tasks.create({ projectId: project.id, title: "Blocked", plan, blockedBy: [planned.id] });
    s.tasks.move(blocked.id, { status: "in_progress" }, "agent");
    expect(refused(() => ask(blocked.id))).toMatch(/blocked by unfinished tasks/);

    expect(
      refused(() => s.taskSessions.request({ taskId: task.id, note: "x", actor: "autopilot", projectId: other.id })),
    ).toMatch(/isn't in the project this run looks after/);

    const busy = s.tasks.create({ projectId: project.id, title: "Busy", plan });
    s.tasks.move(busy.id, { status: "in_progress" }, "agent");
    s.links.add(busy.id, { value: "t3code://threads/env/thread-1" }, "agent");
    expect(refused(() => ask(busy.id))).toMatch(/already has a T3 thread working on it/);

    // A task a connected machine holds is that machine's Autopilot's: the board would never run the session.
    const held = s.tasks.create({ projectId: project.id, title: "Held", plan });
    s.tasks.move(held.id, { status: "in_progress" }, "agent");
    const machine = s.machines.add({
      instanceId: "engine-1",
      name: "engine",
      routes: [{ kind: "ssh", target: "me@engine", port: null, remotePort: 4318 }],
    });
    createRepos(h.db).holds.insert({
      taskId: held.id,
      machineId: machine.id,
      heldAt: new Date().toISOString(),
      afterLogId: 0,
    });
    expect(refused(() => ask(held.id))).toMatch(/is held by engine, whose own Autopilot looks after it/);

    expect(refused(() => ask())).toBeNull();
    expect(refused(() => ask())).toMatch(/already asked for .* one session per task per hour/);
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    expect(refused(() => ask())).toBeNull();
  });
});
