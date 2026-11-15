import { AUTOPILOT_START_PLANNED } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutopilotEngine } from "../../autopilot/engine.ts";
import { boardPlacement, runnerPlacement } from "../../autopilot/placement.ts";
import type { Runner, RunnerRequest } from "../../autopilot/types.ts";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import { asRunnerRequest } from "./runnerWork.ts";

// Autopilot on a connected machine (docs/features/remote-machines.md#autopilot-on-the-machine): the machine runs the
// board's automations over the tasks it holds, the board leaves those tasks alone, and the machine's runs and
// notifications come back through its log.

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

type Pair = Awaited<ReturnType<typeof createBoardAndRunner>>;

/** A headless agent that starts the task it was given, as a real one moves it out of Planned. */
function agentOn(server: Pair["runner"], started: RunnerRequest[]): Runner {
  return {
    start(request) {
      started.push(request);
      server.services.tasks.move(request.run.taskId!, { status: "in_progress" }, "claude");
      return Promise.resolve({ runner: "headless", result: "Done" });
    },
  };
}

async function setup(options: Parameters<typeof createBoardAndRunner>[0] = {}) {
  const pair = await createBoardAndRunner({
    remotes: { "/work/app": "git@github.com:acme/app.git" },
    ...options,
  });
  stops.push(pair.stop);
  const { board, runner } = pair;
  const project = board.services.projects.create({
    title: "App",
    workspaceRoot: "/work/app",
  });
  board.services.autopilot.setScope("project", project.id, AUTOPILOT_START_PLANNED, { mode: "on" });
  const plan = { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] };
  const first = board.services.tasks.create({
    projectId: project.id,
    title: "First",
    plan,
  });
  const second = board.services.tasks.create({
    projectId: project.id,
    title: "Second",
    plan,
    blockedBy: [first.id],
  });
  for (const task of [first, second]) {
    board.services.tasks.move(task.id, { status: "planned" }, "user");
    board.services.tasks.update(task.id, { autopilot: true }, "user");
  }

  const onRunner: RunnerRequest[] = [];
  const onBoard: RunnerRequest[] = [];
  const runnerEngine = createAutopilotEngine({
    services: () => runner.services,
    bus: runner.bus,
    runner: agentOn(runner, onRunner),
    placement: runnerPlacement(() => runner.services, runner.instanceId),
    reminders: false,
    log: { warn: () => {} },
  });
  const boardEngine = createAutopilotEngine({
    services: () => board.services,
    bus: board.bus,
    runner: agentOn(board, onBoard),
    placement: boardPlacement(
      () => board.services,
      (id) => board.integrations.machines.can(id, "autopilot"),
    ),
    log: { warn: () => {} },
  });
  /** A pass of the runner's engine, with its agents done. */
  const runnerPass = async () => {
    await runnerEngine.pass();
    await runnerEngine.idle();
  };
  const boardPass = async () => {
    await boardEngine.pass();
    await boardEngine.idle();
  };
  return {
    ...pair,
    project,
    first,
    second,
    onRunner,
    onBoard,
    runnerPass,
    boardPass,
  };
}

describe("Autopilot on a machine", () => {
  it("runs the board's switches over the tasks the machine holds, and the board leaves them alone", async () => {
    const { board, runner, machine, first, second, onRunner, onBoard, runnerPass, boardPass, sync } = await setup();
    await board.integrations.machineSync.handOver(first.id, machine.id, "user");
    await board.integrations.machineSync.handOver(second.id, machine.id, "user");

    // The board's switch reached the machine, under the machine's own id for the project.
    const runnerProject = runner.services.tasks.summary(first.id).projectId;
    const startPlanned = runner.services.autopilot.automations().find((a) => a.key === AUTOPILOT_START_PLANNED)!;
    expect(runner.services.autopilot.resolve(startPlanned, runnerProject).enabled).toBe(true);

    await boardPass();
    expect(onBoard).toEqual([]);

    await runnerPass();
    expect(onRunner.map((r) => r.run.taskId)).toEqual([first.id]);
    // A runner's runs go headless and from origin, whatever the automation's runner says.
    expect(asRunnerRequest(onRunner[0]!)).toMatchObject({
      options: { runner: "headless" },
      workspace: { fromOrigin: true },
    });

    await sync();
    expect(board.services.tasks.summary(first.id).status).toBe("in_progress");
    const runs = board.services.autopilot.runsForTask(first.id);
    expect(runs).toMatchObject([
      {
        automation: AUTOPILOT_START_PLANNED,
        status: "succeeded",
        machine: { id: machine.id, name: "engine" },
      },
    ]);
    // The board's own limits don't count what ran on the machine.
    expect(board.services.autopilot.usage([AUTOPILOT_START_PLANNED], new Date(0).toISOString()).started).toBe(0);
    expect(
      board.services.autopilot.usage([AUTOPILOT_START_PLANNED], new Date(0).toISOString(), machine.id).started,
    ).toBe(1);
  });

  it("keeps a chain going while the board can't be reached, and the board catches up", async () => {
    const { board, runner, machine, first, second, onRunner, runnerPass, sync, link } = await setup();
    await board.integrations.machineSync.handOver(first.id, machine.id, "user");
    await board.integrations.machineSync.handOver(second.id, machine.id, "user");
    await runnerPass();

    await link(false);
    // The agent finishes the first task; the machine starts the one it blocked by itself.
    runner.services.tasks.move(first.id, { status: "done" }, "claude");
    await runnerPass();
    expect(onRunner.map((r) => r.run.taskId)).toEqual([first.id, second.id]);

    await link(true);
    await sync();
    expect(board.services.tasks.summary(first.id).status).toBe("done");
    expect(board.services.tasks.summary(second.id).status).toBe("in_progress");
    expect(board.services.autopilot.runsForTask(second.id)).toMatchObject([
      { status: "succeeded", machine: { name: "engine" } },
    ]);
  });

  it("starts a held task once a blocker the board holds finishes there", async () => {
    const { board, machine, first, second, onRunner, onBoard, runnerPass, boardPass, sync } = await setup();
    // Only the second goes to the machine: the first stays on the board, and the board starts it.
    await board.integrations.machineSync.handOver(second.id, machine.id, "user");
    await boardPass();
    expect(onBoard.map((r) => r.run.taskId)).toEqual([first.id]);
    await runnerPass();
    expect(onRunner).toEqual([]);

    board.services.tasks.move(first.id, { status: "done" }, "user");
    await sync();
    await runnerPass();
    expect(onRunner.map((r) => r.run.taskId)).toEqual([second.id]);
  });

  it("hands over the tasks a flagged task blocks that resolve to the same machine", async () => {
    let machineId = "";
    const { board, machine, first, second, project } = await setup({
      board: { machineFor: () => machineId },
    });
    machineId = machine.id;
    const elsewhere = board.services.tasks.create({
      projectId: project.id,
      title: "Third",
      blockedBy: [second.id],
    });
    await board.integrations.machineSync.handOver(first.id, machine.id, "user");
    expect(board.services.holds.get(second.id)?.machineId).toBe(machine.id);
    expect(board.services.holds.get(elsewhere.id)?.machineId).toBe(machine.id);
  });

  it("leaves dependents that resolve to the board where they are", async () => {
    const { board, machine, first, second } = await setup();
    await board.integrations.machineSync.handOver(first.id, machine.id, "user");
    expect(board.services.holds.get(second.id)).toBeNull();
  });

  it("raises the machine's notifications in the board's inbox", async () => {
    const { board, runner, machine, first, sync } = await setup();
    await board.integrations.machineSync.handOver(first.id, machine.id, "user");
    runner.services.attention.request(first.id, "Which database?", "claude");
    await sync();
    expect(board.services.notifications.list().items).toMatchObject([
      {
        kind: "agent_request",
        taskId: first.id,
        body: expect.stringContaining("Which database?"),
      },
    ]);
  });

  it("carries Pause all and the machine's own limits, and says whether they arrived", async () => {
    const { board, runner, machine, first, onRunner, runnerPass, sync, link } = await setup();
    await board.integrations.machineSync.handOver(first.id, machine.id, "user");
    board.services.autopilot.setMachineLimits(machine.id, { maxConcurrent: 3 });
    expect(runner.services.autopilot.engine().maxConcurrent).toBe(1);

    await link(false);
    board.services.autopilot.setPaused(true);
    expect(board.integrations.autopilotSync.machines()).toMatchObject([{ pauseDelivered: false, ownLimits: true }]);

    await link(true);
    await sync();
    expect(runner.services.autopilot.status().paused).toBe(true);
    expect(runner.services.autopilot.engine().maxConcurrent).toBe(3);
    expect(board.services.autopilot.engine().maxConcurrent).toBe(1);
    expect(board.integrations.autopilotSync.machines()).toMatchObject([{ pauseDelivered: true, synced: true }]);
    await runnerPass();
    expect(onRunner).toEqual([]);
  });

  it("runs a scheduled automation pinned to the machine there, and not on the board", async () => {
    const { board, runner, machine, project, sync, cloned } = await setup();
    const custom = board.services.customAutomations.create({
      name: "Nightly",
      trigger: {
        kind: "schedule",
        schedule: { kind: "hourly", everyHours: 1 },
      },
      action: { kind: "shell", command: "echo hi" },
      projectIds: [project.id],
    });
    board.services.customAutomations.setMachine(custom.id, machine.id);
    await sync();
    const there = runner.services.customAutomations.get(custom.id);
    expect(there.machineId).toBe(runner.instanceId);
    const key = `custom:${custom.id}`;
    const automation = (s: typeof board.services) => s.autopilot.automations().find((a) => a.key === key)!;
    const candidate = { dedupeKey: "x", summary: "run", projectId: project.id };
    expect(
      boardPlacement(
        () => board.services,
        () => true,
      ).owns(candidate, automation(board.services)),
    ).toBe(false);
    const runnerSide = runnerPlacement(() => runner.services, runner.instanceId);
    expect(runnerSide.runsHere(automation(runner.services))).toBe(true);
    expect(runnerSide.owns(candidate, automation(runner.services))).toBe(true);

    // The machine clones the project it runs in and switches the automation on there, as the board has it.
    await vi.waitFor(() => expect(cloned).toHaveLength(1));
    const cloneThere = await vi.waitFor(() => {
      const found = runner.services.workingCopies.projectFor({
        id: project.id,
        title: "",
        remote: null,
        remoteUrl: null,
      });
      expect(found).not.toBeNull();
      return found!;
    });
    expect(runner.services.autopilot.resolve(automation(runner.services), cloneThere.id).enabled).toBe(true);
  });

  it("keeps a machine's run when the board tried the same work before handing the task over", async () => {
    const { board, machine, first } = await setup();
    const tried = board.services.autopilot.record({
      automation: AUTOPILOT_START_PLANNED,
      candidate: { dedupeKey: "start:x", summary: "start", taskId: first.id },
      dryRun: false,
    })!;
    board.services.autopilot.finish(tried.id, { status: "failed", error: "cut short" });
    board.services.autopilot.keepFromMachine(
      { ...tried, id: "machine-run", status: "succeeded", error: null },
      { id: machine.id, name: "engine" },
    );
    const runs = board.services.autopilot.runsForTask(first.id);
    expect(runs.find((r) => r.id === "machine-run")).toMatchObject({
      dedupeKey: "start:x",
      machine: { name: "engine" },
    });
    expect(runs.find((r) => r.id === tried.id)?.dedupeKey).toBe(`retried:${tried.id}:start:x`);
  });
});
