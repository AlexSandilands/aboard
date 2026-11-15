import { AUTOPILOT_REVIEW_PRS, AUTOPILOT_START_PLANNED, RUN_HERE, type AutopilotRun } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import { taskRunsOn } from "../../services/runOn.ts";
import { handOverAtStart } from "./startOn.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function setup() {
  const pair = await createBoardAndRunner();
  stops.push(pair.stop);
  const { board } = pair;
  const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }] }] },
  });
  return { ...pair, project, task };
}

const runFor = (taskId: string, automation = AUTOPILOT_START_PLANNED, dryRun = false) =>
  ({ run: { automation, taskId, dryRun } as AutopilotRun }) as const;

describe("where a task runs, on the board", () => {
  it("resolves the task's choice, then its project's, then this machine", async () => {
    const { board, machine, project, task } = await setup();
    expect(taskRunsOn(board.services, task.id)).toEqual({ machineId: null, machineName: null, source: "board" });
    board.services.projects.update(project.id, { runOn: machine.id });
    expect(taskRunsOn(board.services, task.id)).toMatchObject({ machineId: machine.id, source: "project" });
    board.services.tasks.setRunOn(task.id, RUN_HERE, "user");
    expect(taskRunsOn(board.services, task.id)).toEqual({ machineId: null, machineName: null, source: "task" });
  });

  it("hands the task to its machine when Start planned starts it, and only then", async () => {
    const { board, machine, task } = await setup();
    const sync = board.integrations.machineSync;
    board.services.tasks.setRunOn(task.id, machine.id, "user");

    // Other runs, and a dry run, start nothing anywhere.
    await handOverAtStart(board.services, sync, runFor(task.id, AUTOPILOT_REVIEW_PRS));
    await handOverAtStart(board.services, sync, runFor(task.id, AUTOPILOT_START_PLANNED, true));
    expect(board.services.holds.get(task.id)).toBeNull();

    await handOverAtStart(board.services, sync, runFor(task.id));
    expect(board.services.holds.get(task.id)).toMatchObject({ machineId: machine.id });
    expect(board.services.tasks.summary(task.id).hold).toMatchObject({ machineName: machine.name });
    // A second start of the same task leaves the hold as it is.
    await handOverAtStart(board.services, sync, runFor(task.id));
    expect(board.services.holds.get(task.id)).toMatchObject({ machineId: machine.id });
  });

  it("keeps a task set to this machine here", async () => {
    const { board, machine, project, task } = await setup();
    board.services.projects.update(project.id, { runOn: machine.id });
    board.services.tasks.setRunOn(task.id, RUN_HERE, "user");
    await handOverAtStart(board.services, board.integrations.machineSync, runFor(task.id));
    expect(board.services.holds.get(task.id)).toBeNull();
  });
});

describe("pulling a task back", () => {
  it("is refused while a run for it is going there, then takes it back to stay here", async () => {
    const { board, machine, task, sync } = await setup();
    board.services.tasks.setRunOn(task.id, machine.id, "user");
    await handOverAtStart(board.services, board.integrations.machineSync, runFor(task.id));
    board.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    await sync();

    const run = board.services.autopilot.record({
      automation: AUTOPILOT_REVIEW_PRS,
      candidate: { dedupeKey: "review:1", summary: "review PR #1", taskId: task.id },
      dryRun: false,
    })!;
    board.services.autopilot.update(run.id, { status: "running" } as never);
    await expect(board.integrations.machineSync.pullBack(task.id, {}, "user")).rejects.toThrow(
      /Review PRs is running on .* Pull it back once that finishes/,
    );
    expect(board.services.holds.get(task.id)).not.toBeNull();

    board.services.autopilot.finish(run.id, { status: "succeeded", summary: "Reviewed" });
    const detail = await board.integrations.machineSync.pullBack(task.id, {}, "user");
    expect(detail.hold ?? null).toBeNull();
    expect(detail.runOn).toBe(RUN_HERE);
    expect(taskRunsOn(board.services, task.id)).toMatchObject({ machineId: null, source: "task" });
  });
});

describe("pulling a task back by force", () => {
  it("doesn't wait for a run there, and says a queued run is queued", async () => {
    const { board, machine, task } = await setup();
    board.services.tasks.setRunOn(task.id, machine.id, "user");
    await handOverAtStart(board.services, board.integrations.machineSync, runFor(task.id));
    board.services.autopilot.record({
      automation: AUTOPILOT_REVIEW_PRS,
      candidate: { dedupeKey: "review:2", summary: "review PR #2", taskId: task.id },
      dryRun: false,
    });
    await expect(board.integrations.machineSync.pullBack(task.id, {}, "user")).rejects.toThrow(
      /Review PRs is queued for #\d+\. Pull it back once that finishes/,
    );
    const detail = await board.integrations.machineSync.pullBack(task.id, { force: true }, "user");
    expect(detail.hold ?? null).toBeNull();
    expect(detail.runOn).toBe(RUN_HERE);
  });
});
