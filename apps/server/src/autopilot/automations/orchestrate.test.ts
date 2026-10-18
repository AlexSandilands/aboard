import { BRAND, type PlanInput } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { RunnerRequest, RunnerResult } from "../types.ts";
import { AUTOPILOT_ORCHESTRATE, orchestrate, orchestratePrompt } from "./orchestrate.ts";

const plan: PlanInput = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const MINUTE = 60_000;

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup(opts: { agent?: (request: RunnerRequest) => Promise<RunnerResult> } = {}) {
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
      repo: "/work/alpha",
      options: { runner: "headless", everyMinutes: 15 },
    });
    expect(request.tools).toContain("Bash(gh pr checks *)");
    expect(request.deniedTools).toBeUndefined();
    expect(request.outputSchema).toMatchObject({ required: ["summary", "handover"] });
    expect(request.prompt).toContain("merge_task_pr(task)");

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
    expect(request.deniedTools).toEqual([`mcp__${BRAND.id}__merge_task_pr`]);
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
