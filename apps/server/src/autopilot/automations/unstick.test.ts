import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { Runner, RunnerRequest } from "../types.ts";
import { AUTOPILOT_UNSTICK, unstick } from "./unstick.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup() {
  // The clock is ours: tasks and snapshots are stamped for real now, and the engine looks `later` ms on.
  let later = 0;
  const nudges: RunnerRequest[] = [];
  const runner: Runner = {
    start: (request) => {
      nudges.push(request);
      return Promise.resolve({ result: null });
    },
  };
  const h = createTestHarness({ integrations: { automations: [unstick] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    now: () => new Date(Date.now() + later),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const working = (title = "Working") => {
    const task = s.tasks.create({ projectId: project.id, title, plan });
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    return task;
  };
  const withThread = (taskId: string, status: "input" | "working" | "approval", n = 1) => {
    s.links.add(taskId, { value: `t3code://threads/env/thread-${n}` }, "agent");
    const link = s.tasks.detail(taskId).links.at(-1)!;
    s.links.setSnapshot(link.id, { title: "T", status, lastActivityAt: new Date().toISOString() });
  };
  const pass = async (ms: number) => {
    later = ms;
    await engine.pass();
    await engine.idle();
  };
  const runs = () => s.autopilot.runsForProject(project.id).filter((r) => r.automation === AUTOPILOT_UNSTICK);
  const turnOn = (config?: Record<string, unknown>) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_UNSTICK, { mode: "on", ...(config ? { config } : {}) });
  const notices = () => s.notifications.list({ kind: "autopilot_notice" }).items;
  return { ...h, s, project, working, withThread, pass, runs, turnOn, nudges, notices };
}

describe("unstick stale tasks", () => {
  it("flags a task with no activity past the limit, once, and ignores its own entries", async () => {
    const { s, working, pass, runs, turnOn, notices } = setup();
    const task = working();
    turnOn();
    await pass(23 * HOUR_MS);
    expect(runs()).toHaveLength(0);
    await pass(26 * HOUR_MS);
    expect(runs()).toMatchObject([{ status: "succeeded", summary: "Stale: no activity for 26h" }]);
    expect(s.tasks.summary(task.id).attention).toContainEqual({
      kind: "autopilot",
      severity: "warning",
      message: "Stale: no activity for 26h",
    });
    expect(notices()).toHaveLength(1);
    // Its own note and run entries are not activity: a later pass finds the same quiet period and does nothing.
    await pass(30 * HOUR_MS);
    expect(runs()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it("clears the reason on new activity, and flags the next quiet period again", async () => {
    const { s, working, pass, runs, turnOn } = setup();
    const task = working();
    turnOn({ staleHours: 1 });
    await pass(2 * HOUR_MS);
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toContain("autopilot");
    await new Promise((r) => setTimeout(r, 5));
    s.tasks.addNote(task.id, "back at it", "agent");
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).not.toContain("autopilot");
    await pass(4 * HOUR_MS);
    expect(runs()).toHaveLength(2);
  });

  it("flags a thread waiting on input past the limit, once, without a card reason of its own", async () => {
    const { working, withThread, pass, runs, turnOn, notices } = setup();
    const task = working();
    withThread(task.id, "input");
    turnOn();
    await pass(20 * MINUTE_MS);
    expect(runs()).toHaveLength(0);
    await pass(45 * MINUTE_MS);
    expect(runs()).toMatchObject([{ summary: "Thread waiting for input for 45m", needsAttention: false }]);
    expect(notices().map((n) => n.title)).toEqual([`#${task.number} is waiting for you`]);
    await pass(50 * MINUTE_MS);
    expect(runs()).toHaveLength(1);
  });

  it("ignores a thread that is working, and tasks that aren't In Progress", async () => {
    const { s, project, working, withThread, pass, runs, turnOn } = setup();
    withThread(working().id, "working");
    s.tasks.create({ projectId: project.id, title: "planned", plan });
    turnOn({ staleHours: 100 });
    await pass(2 * HOUR_MS);
    expect(runs()).toHaveLength(0);
  });

  it("nudges the live thread only when switched on", async () => {
    const { working, withThread, pass, turnOn, nudges, runs } = setup();
    const task = working();
    withThread(task.id, "input");
    turnOn();
    await pass(45 * MINUTE_MS);
    expect(nudges).toHaveLength(0);

    const other = working("Other");
    withThread(other.id, "input", 2);
    turnOn({ nudge: true, nudgeMessage: "Report in" });
    await pass(46 * MINUTE_MS);
    expect(nudges).toMatchObject([{ kind: "nudge", prompt: "Report in" }]);
    expect(runs().find((r) => r.taskId === other.id)?.summary).toContain("nudged the thread");
  });

  it("says so when there is no thread to nudge, and still notifies", async () => {
    const { working, pass, turnOn, nudges, runs, notices } = setup();
    working();
    turnOn({ staleHours: 1, nudge: true });
    await pass(2 * HOUR_MS);
    expect(nudges).toHaveLength(0);
    expect(runs()[0]?.summary).toContain("couldn't nudge: it has no live T3 Code thread");
    expect(notices()).toHaveLength(1);
  });

  it("only previews in dry-run", async () => {
    const { s, working, pass, runs, turnOn, notices } = setup();
    const task = working();
    s.autopilot.updateEngine({ dryRun: true });
    turnOn({ staleHours: 1 });
    await pass(2 * HOUR_MS);
    expect(runs()).toMatchObject([
      { status: "skipped", dryRun: true, summary: `Would flag #${task.number}: no activity for 2h` },
    ]);
    expect(notices()).toHaveLength(0);
  });
});
