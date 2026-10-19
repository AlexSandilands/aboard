import { BRAND, type PlanInput } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { RunnerRequest, RunnerResult } from "../types.ts";
import {
  AUTOPILOT_ORCHESTRATE,
  ORCHESTRATE_DENIED_TOOLS,
  orchestrate,
  orchestratePrompt,
  orchestrateState,
  requestOrchestrateRun,
} from "./orchestrate.ts";

const plan: PlanInput = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const MINUTE = 60_000;

const engines: AutopilotEngine[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const engine of engines.splice(0)) engine.stop();
});

function setup(opts: { agent?: (request: RunnerRequest) => Promise<RunnerResult> } = {}) {
  // Midday, so the next slot and the daily caps never straddle local midnight, which they do in the last half hour of
  // a real day (the caps don't hold a slot that falls on the next day).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 17, 13, 44));
  let offsetMs = 0;
  const h = createTestHarness({ integrations: { automations: [orchestrate] } });
  const agentRuns: RunnerRequest[] = [];
  let n = 0;
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: {
      start: (request) => {
        agentRuns.push(request);
        n += 1;
        return opts.agent
          ? opts.agent(request)
          : Promise.resolve({
              runner: "headless",
              result: null,
              output: { summary: `pass ${n}`, handover: `holding #${n}` },
            });
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
  const busyTask = (projectId = project.id) => {
    const task = s.tasks.create({ projectId, title: "Busy", plan });
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    return task;
  };
  const pass = async (laterMs = 0, { wait = true } = {}) => {
    offsetMs = laterMs;
    await engine.pass();
    if (wait) await engine.idle();
  };
  const on = (config: Record<string, unknown> = {}) =>
    s.autopilot.setScope("board", null, AUTOPILOT_ORCHESTRATE, { mode: "on", config });
  return { ...h, s, engine, project, other, busyTask, pass, on, agentRuns };
}

describe("Orchestrate", () => {
  it("does nothing while it is off", async () => {
    const { busyTask, pass, agentRuns } = setup();
    busyTask();
    await pass();
    await pass(60 * MINUTE);
    expect(agentRuns).toEqual([]);
  });

  it("runs once per slot per project with work, task-less, headless, read-only with gh reads", async () => {
    const { s, project, other, busyTask, pass, on, agentRuns } = setup();
    busyTask();
    on({ everyMinutes: 15 });
    await pass();
    await pass();
    expect(agentRuns).toHaveLength(1);
    const request = agentRuns[0]!;
    // Beta has nothing going on, so it isn't looked at.
    expect(s.autopilot.runsForProject(other.id)).toEqual([]);
    expect(request.run).toMatchObject({ taskId: null, projectId: project.id, automation: AUTOPILOT_ORCHESTRATE });
    expect(request.run.dedupeKey).toMatch(new RegExp(`^orchestrate:${project.id}:`));
    expect(request).toMatchObject({
      label: "Orchestrate · Alpha",
      access: "read-only",
      untrustedInput: true,
      boardTools: true,
      repo: "/work/alpha",
      options: { runner: "headless", everyMinutes: 15 },
    });
    expect(request.tools).toContain("Bash(gh pr checks *)");
    // It reads text anyone can write, so it can't flag tasks for auto-merge, or close, move or delete them.
    expect(request.deniedTools).toEqual(ORCHESTRATE_DENIED_TOOLS);
    expect(request.deniedTools).toContain(`mcp__${BRAND.id}__update_task`);
    expect(request.deniedTools).not.toContain(`mcp__${BRAND.id}__merge_task_pr`);
    expect(request.outputSchema).toMatchObject({ required: ["summary", "handover"] });
    expect(request.prompt).toContain("merge_task_pr(task)");
    // The allow list takes plain commands only, so the prompt says so rather than leaving a refusal to read as "Bash is off".
    expect(request.prompt).toContain("Run each `gh` command on its own, one per Bash call");
    expect(request.prompt).toContain("not that Bash is off");

    // The next slot runs again; the one after a long gap catches up once.
    await pass(15 * MINUTE);
    expect(agentRuns).toHaveLength(2);
    await pass(4 * 60 * MINUTE);
    await pass(4 * 60 * MINUTE);
    expect(agentRuns).toHaveLength(3);
  });

  it("passes each run the last run's handover and keeps the answer on the run", async () => {
    const { s, project, busyTask, pass, on, agentRuns } = setup();
    busyTask();
    on();
    await pass();
    expect(agentRuns[0]!.prompt).toContain("There is no handover");
    expect(s.autopilot.runsForProject(project.id)[0]!.output).toEqual({
      kind: "scheduled_agent",
      summary: "pass 1",
      handover: "holding #1",
    });
    await pass(30 * MINUTE);
    expect(agentRuns[1]!.prompt).toContain("<handover>\nholding #1\n</handover>");
  });

  it("doesn't run for a project whose only work is waiting on the user", async () => {
    const { s, busyTask, pass, on, agentRuns } = setup();
    const task = busyTask();
    s.attention.request(task.id, "Pick a library", "agent");
    on();
    await pass();
    expect(agentRuns).toEqual([]);
  });

  it("leaves out Review tasks only the user merges, and Planned tasks Start planned hasn't failed on", async () => {
    const { s, project, pass, on, agentRuns } = setup();
    const review = s.tasks.create({ projectId: project.id, title: "Mine to merge", plan });
    s.tasks.move(review.id, { status: "review" }, "agent");
    s.tasks.create({ projectId: project.id, title: "Waiting to start", plan, autopilot: true });
    on();
    await pass();
    expect(agentRuns).toEqual([]);
    s.tasks.update(review.id, { autoMerge: true }, "user");
    await pass(30 * MINUTE);
    expect(agentRuns).toHaveLength(1);
  });

  it("waits for a run still going in the project, and leaves other projects alone", async () => {
    const { s, other, busyTask, pass, on, agentRuns } = setup({ agent: () => new Promise(() => {}) });
    s.autopilot.updateEngine({ maxConcurrent: 5 });
    busyTask();
    on({ everyMinutes: 5 });
    await pass(0, { wait: false });
    await pass(5 * MINUTE, { wait: false });
    expect(agentRuns).toHaveLength(1);
    busyTask(other.id);
    await pass(10 * MINUTE, { wait: false });
    expect(agentRuns.map((r) => r.label)).toEqual(["Orchestrate · Alpha", "Orchestrate · Beta"]);
  });

  it("denies merge_task_pr and says not to merge with May merge off, and appends the user's instructions", async () => {
    const { busyTask, pass, on, agentRuns } = setup();
    busyTask();
    on({ mayMerge: false, instructions: "Hold anything touching the editor." });
    await pass();
    const request = agentRuns[0]!;
    expect(request.deniedTools).toEqual([...ORCHESTRATE_DENIED_TOOLS, `mcp__${BRAND.id}__merge_task_pr`]);
    expect(request.prompt).toContain("Don't merge");
    expect(request.prompt).not.toContain("merge_task_pr(task)");
    expect(request.prompt).toContain("Hold anything touching the editor.");
  });
});

describe("orchestratePrompt", () => {
  const project = { id: "p1", title: "Alpha", workspaceRoot: "/work/alpha" };

  it("names the project, its live folder and the tools for each kind of stall", () => {
    const prompt = orchestratePrompt({ project, mayMerge: true, instructions: "", handover: null });
    expect(prompt).toContain('board_overview(workspacePath "/work/alpha")');
    expect(prompt).toContain("Don't read or edit files in the project's folder (/work/alpha)");
    for (const tool of ["message_task_thread", "start_task_thread", "retry_autopilot_run", "request_attention"]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain("Never start a second thread on a task");
    expect(prompt).toContain("never start one yourself");
    expect(prompt).toContain("re-check the other open PRs' checks");
    expect(prompt).not.toContain("The user's own instructions");
  });

  it("uses the project id when the project has no folder", () => {
    const prompt = orchestratePrompt({
      project: { ...project, workspaceRoot: null },
      mayMerge: true,
      instructions: "",
      handover: null,
    });
    expect(prompt).toContain('board_overview(projectId "p1")');
    expect(prompt).not.toContain("project's folder");
  });
});

describe("Orchestrate's Run now and state", () => {
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const quietAroundNow = () => ({
    enabled: true,
    start: hhmm(new Date(Date.now() - 60 * MINUTE)),
    end: hhmm(new Date(Date.now() + 120 * MINUTE)),
  });

  it("runs at once on request, even with nothing to look at, under its own key, and only once", async () => {
    const { s, project, busyTask, pass, on, agentRuns } = setup();
    on();
    await pass();
    expect(agentRuns).toEqual([]);
    expect(orchestrateState(s, project.id, new Date()).hold).toBe("idle");

    const requested = requestOrchestrateRun(s, project.id, new Date());
    expect(requested.requestedAt).not.toBeNull();
    await pass();
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]!.run.dedupeKey).toBe(`orchestrate:${project.id}:manual:${requested.requestedAt}`);
    expect(agentRuns[0]!.run.summary).toBe("look over Alpha (run now)");
    await pass();
    expect(agentRuns).toHaveLength(1);
    expect(s.autopilot.runRequest(AUTOPILOT_ORCHESTRATE, project.id)).toBeNull();

    // Work turning up in the same slot waits for the next one: the manual run already looked.
    busyTask();
    await pass();
    expect(agentRuns).toHaveLength(1);
    await pass(30 * MINUTE);
    expect(agentRuns).toHaveLength(2);
    expect(agentRuns[1]!.run.dedupeKey).not.toContain(":manual:");
  });

  it("refuses when off, paused, already running, in quiet hours or at a daily cap", async () => {
    const { s, project, busyTask, pass, on } = setup({ agent: () => new Promise(() => {}) });
    const ask = () => requestOrchestrateRun(s, project.id, new Date());
    expect(ask).toThrow("Orchestrate is off in Alpha");
    on();
    s.autopilot.setPaused(true);
    expect(ask).toThrow("Autopilot is paused");
    s.autopilot.setPaused(false);
    s.autopilot.updateEngine({ quietHours: quietAroundNow() });
    expect(ask).toThrow("It's quiet hours");
    s.autopilot.updateEngine({ quietHours: { enabled: false } });
    s.autopilot.updateEngine({ dailyRunCap: 1, maxConcurrent: 2 });
    busyTask();
    await pass(0, { wait: false });
    expect(ask).toThrow("Orchestrate is already running in Alpha");
    expect(orchestrateState(s, project.id, new Date())).toMatchObject({ running: true, requestedAt: null });
    expect(s.autopilot.runRequest(AUTOPILOT_ORCHESTRATE, project.id)).toBeNull();
  });

  it("waits for a free slot at the concurrency cap rather than refusing", async () => {
    const { s, project, other, busyTask, pass, on, agentRuns } = setup({ agent: () => new Promise(() => {}) });
    on();
    busyTask(other.id);
    await pass(0, { wait: false });
    expect(agentRuns).toHaveLength(1);
    const state = requestOrchestrateRun(s, project.id, new Date());
    expect(state.requestedAt).not.toBeNull();
    await pass(0, { wait: false });
    expect(agentRuns).toHaveLength(1);
    expect(orchestrateState(s, project.id, new Date()).requestedAt).toBe(state.requestedAt);
  });

  it("refuses at a daily cap even while every run slot is taken, and drops a request when switched off", async () => {
    const { s, project, other, busyTask, pass, on } = setup({ agent: () => new Promise(() => {}) });
    on();
    busyTask(other.id);
    await pass(0, { wait: false });
    s.autopilot.updateEngine({ dailyRunCap: 1 });
    expect(() => requestOrchestrateRun(s, project.id, new Date())).toThrow("Today's Autopilot run cap is reached");
    expect(orchestrateState(s, project.id, new Date()).hold).toBe("daily_cap");

    s.autopilot.updateEngine({ dailyRunCap: null });
    requestOrchestrateRun(s, project.id, new Date());
    s.autopilot.setScope("project", project.id, AUTOPILOT_ORCHESTRATE, { mode: "off" });
    expect(s.autopilot.runRequest(AUTOPILOT_ORCHESTRATE, project.id)).toBeNull();
    s.autopilot.setScope("project", project.id, AUTOPILOT_ORCHESTRATE, { mode: "inherit" });
    expect(orchestrateState(s, project.id, new Date()).requestedAt).toBeNull();
  });

  it("drops a request the engine hasn't acted on within an hour", () => {
    const { s, project, on } = setup();
    on();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      requestOrchestrateRun(s, project.id, new Date());
      vi.setSystemTime(Date.now() + 59 * MINUTE);
      expect(s.autopilot.runRequest(AUTOPILOT_ORCHESTRATE, project.id)).not.toBeNull();
      vi.setSystemTime(Date.now() + 2 * MINUTE);
      expect(s.autopilot.runRequest(AUTOPILOT_ORCHESTRATE, project.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the next slot, the latest run and what holds the next slot back", async () => {
    const { s, project, busyTask, pass, on } = setup();
    const now = new Date(2026, 9, 17, 13, 44);
    const state = () => orchestrateState(s, project.id, now);
    expect(state()).toMatchObject({ enabled: false, everyMinutes: 30, hold: "off", running: false, lastRun: null });
    expect(new Date(state().nextSlotAt)).toEqual(new Date(2026, 9, 17, 14, 0));
    on({ everyMinutes: 15 });
    expect(state()).toMatchObject({ enabled: true, everyMinutes: 15, hold: "idle" });
    expect(new Date(state().nextSlotAt)).toEqual(new Date(2026, 9, 17, 13, 45));
    busyTask();
    expect(state().hold).toBeNull();
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "13:45", end: "14:00" } });
    expect(state().hold).toBe("quiet_hours");
    s.autopilot.updateEngine({ quietHours: { enabled: false } });
    s.autopilot.setPaused(true);
    expect(state().hold).toBe("paused");
    s.autopilot.setPaused(false);

    await pass();
    expect(orchestrateState(s, project.id, new Date()).lastRun).toMatchObject({
      status: "succeeded",
      summary: "Looked over Alpha",
    });
    s.autopilot.updateEngine({ dailyRunCap: 1 });
    expect(orchestrateState(s, project.id, new Date()).hold).toBe("daily_cap");
    expect(() => requestOrchestrateRun(s, project.id, new Date())).toThrow("Today's Autopilot run cap is reached");
  });
});
