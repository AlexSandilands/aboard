import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";

// Replay of a machine's change log on the board, and the board's own edits to a task the machine holds.

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function setup() {
  const pair = await createBoardAndRunner();
  stops.push(pair.stop);
  const { board, runner, machine } = pair;
  const project = board.services.projects.create({ title: "App" });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }, { title: "Test it" }] }] },
  });
  await board.integrations.machineSync.handOver(task.id, machine.id, "user");
  await pair.sync();
  const [write, test] = task.phases[0]!.steps;
  /** What the runner would answer the board's next read with. */
  const pending = () => {
    const position = board.services.holds.position(machine.id);
    return runner.services.workingCopies.changes(position.appliedLogId, position.epoch ?? undefined);
  };
  const onBoard = () => board.services.tasks.detail(task.id);
  const onRunner = () => runner.services.tasks.detail(task.id);
  const types = <E extends { type: string }>(events: E[], type: string): E[] => events.filter((e) => e.type === type);
  /** Lets what was started without being awaited (an edit sent as soon as it is made) finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { ...pair, project, task, write: write!, test: test!, pending, onBoard, onRunner, types, settle };
}

describe("replaying a machine's log", () => {
  it("applies an entry once, however often it arrives", async () => {
    const { board, runner, machine, task, pending, onBoard, types } = await setup();
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.tasks.addNote(task.id, "Once", "claude");
    const answer = pending();

    expect(board.services.holds.apply(machine.id, answer).applied).toBe(2);
    const first = onBoard();
    // The same answer again: a connection that dropped after the runner sent it.
    expect(board.services.holds.apply(machine.id, answer)).toMatchObject({ applied: 0, error: null });
    const second = onBoard();
    expect(second.status).toBe("in_progress");
    expect(types(second.events, "note")).toHaveLength(1);
    expect(types(second.events, "status_changed")).toHaveLength(1);
    expect(second.events).toEqual(first.events);
  });

  it("carries on where it stopped when the connection drops halfway", async () => {
    const { board, runner, machine, task, write, pending, onBoard, sync, net, types } = await setup();
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.plans.updateStep(write.id, { status: "done" }, "claude");
    runner.services.tasks.addNote(task.id, "Three changes in", "claude");
    const answer = pending();
    expect(answer.entries).toHaveLength(3);

    // The first entry gets through, then the link goes.
    board.services.holds.apply(machine.id, { ...answer, entries: answer.entries.slice(0, 1) });
    expect(onBoard().status).toBe("in_progress");
    expect(onBoard().progress.done).toBe(0);
    net.loseAnswers = 1;
    await expect(sync()).rejects.toThrow(/Nothing answers|isn't connected/);
    expect(onBoard().progress.done).toBe(0);

    // Back again: the read starts after the one entry applied, and nothing is applied twice.
    const result = await sync();
    expect(result.applied).toBe(2);
    expect(onBoard().progress.done).toBe(1);
    expect(types(onBoard().events, "status_changed")).toHaveLength(1);
    expect(types(onBoard().events, "note")).toHaveLength(1);
    // What the board has applied is dropped from the runner's log on its next read.
    await sync();
    expect(pending().entries).toHaveLength(0);
    expect(runner.db.prepare("SELECT COUNT(*) AS n FROM change_log").get()).toEqual({ n: 0 });
  });

  it("catches up, in order, on what happened while the board was off", async () => {
    const { board, runner, task, write, test, onBoard, sync, link } = await setup();
    await link(false);
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.plans.updateStep(write.id, { status: "done" }, "claude");
    runner.services.plans.updateStep(test.id, { status: "in_progress", notes: "Flaky on CI" }, "claude");
    runner.services.tasks.addNote(task.id, "First", "claude");
    runner.services.tasks.addNote(task.id, "Second", "claude");
    await expect(sync()).rejects.toThrow(/Nothing answers|isn't connected/);
    expect(onBoard().status).toBe("planned");

    await link(true);
    board.events.length = 0;
    await sync();
    const now = onBoard();
    expect(now.status).toBe("in_progress");
    expect(now.phases[0]?.steps.map((s) => s.status)).toEqual(["done", "in_progress"]);
    expect(now.phases[0]?.steps[1]?.notes).toBe("Flaky on CI");
    expect(now.events.filter((e) => e.type === "note").map((e) => e.payload.text)).toEqual(["First", "Second"]);
    expect(now.lastNote?.text).toBe("Second");
    expect(board.events.filter((e) => e.type === "task.upserted" && e.task.id === task.id)).toHaveLength(1);
  });

  it("moves the task's epic along with it, and keeps the board's own lane order", async () => {
    const { board, runner, project, task, sync } = await setup();
    const epic = board.services.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    board.services.tasks.update(task.id, { epicId: epic.id }, "user");
    const other = board.services.tasks.create({
      projectId: project.id,
      title: "Already in progress",
      plan: { phases: [{ title: "P", steps: [{ title: "S" }] }] },
    });
    board.services.tasks.move(other.id, { status: "in_progress" }, "user");

    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    await sync();
    expect(board.services.tasks.summary(epic.id).status).toBe("in_progress");
    const lane = board.services.tasks.summaries({ projectId: project.id, status: "in_progress" });
    expect(lane.filter((t) => t.kind === "task").map((t) => t.id)).toEqual([other.id, task.id]);
    // The epic stays the board's to decide: the machine's state doesn't carry it.
    expect(board.services.tasks.summary(task.id).parent?.id).toBe(epic.id);
  });

  it("stops at an entry in a format newer than it reads, and takes it up again once it can", async () => {
    const { board, runner, machine, task, pending, onBoard } = await setup();
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.tasks.addNote(task.id, "Written by a newer runner", "claude");
    const answer = pending();
    // The runner updated first: its second entry is in a format this board doesn't know yet.
    const newer = { ...answer, entries: [answer.entries[0]!, { ...answer.entries[1]!, version: 99 }] };

    const result = board.services.holds.apply(machine.id, newer);
    expect(result).toMatchObject({ applied: 1, appliedLogId: answer.entries[0]!.id });
    expect(result.error).toMatch(/is in format 99; this version reads up to/);
    expect(onBoard().status).toBe("in_progress");
    expect(onBoard().lastNote).toBeNull();
    // Nothing is skipped: the position stays before it, so the entry is read once the board can.
    expect(board.services.holds.apply(machine.id, answer)).toMatchObject({ applied: 1, error: null });
    expect(onBoard().lastNote?.text).toBe("Written by a newer runner");
  });

  it("gives back the tasks of a machine whose database was replaced", async () => {
    const { board, runner, machine, task, sync, onBoard } = await setup();
    // A reinstall with the data dir wiped: another log, and nothing held.
    runner.db.exec(
      "DELETE FROM working_copies; DELETE FROM change_log; UPDATE runner_state SET value = 'another-log' WHERE key = 'epoch'",
    );
    await sync();
    expect(onBoard().hold).toBeNull();
    expect(onBoard().events.find((e) => e.type === "released")?.payload).toMatchObject({
      machine: "engine",
      lost: true,
    });
    expect(board.services.holds.position(machine.id)).toMatchObject({ epoch: "another-log", appliedLogId: 0 });
    void task;
  });
});

describe("an edit made on the board to a held task", () => {
  it("goes to the machine at once while it is connected, and comes back through its log", async () => {
    const { board, task, onBoard, onRunner, sync, settle, types } = await setup();
    board.services.tasks.move(task.id, { status: "in_progress" }, "user");
    expect(onBoard().status).toBe("in_progress");
    await settle();
    expect(onRunner().status).toBe("in_progress");
    await sync();

    const now = onBoard();
    expect(now.hold?.waiting).toBe(0);
    // One entry in the activity, the machine's: what the board wrote to show the edit early is gone.
    expect(types(now.events, "status_changed").map((e) => e.actor)).toEqual(["user"]);
    expect(board.db.prepare("SELECT COUNT(*) AS n FROM held_edits").get()).toEqual({ n: 0 });
  });

  it("shows straight away and waits, marked, while the machine can't be reached", async () => {
    const { board, task, write, onBoard, onRunner, link, settle } = await setup();
    await link(false);
    board.events.length = 0;
    board.services.tasks.move(task.id, { status: "review" }, "user");
    board.services.plans.updateStep(write.id, { status: "done" }, "user");
    await settle();

    const shown = onBoard();
    expect(shown.status).toBe("review");
    expect(shown.progress.done).toBe(1);
    expect(shown.hold).toMatchObject({ machineName: "engine", waiting: 2 });
    const published = board.events.flatMap((e) =>
      e.type === "task.upserted" && e.task.id === task.id ? [e.task] : [],
    );
    expect(published.at(-1)?.hold?.waiting).toBe(2);
    expect(onRunner().status).toBe("planned");
  });

  it("lands after what the agent did meanwhile, once the machine is back", async () => {
    const { board, runner, task, write, test, onBoard, onRunner, sync, link, settle, types } = await setup();
    await link(false);
    board.services.tasks.addNote(task.id, "From the board", "user");
    board.services.plans.updateStep(test.id, { notes: "Check the Windows run too" }, "user");
    // Meanwhile, on the machine.
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.plans.updateStep(write.id, { status: "done" }, "claude");
    runner.services.tasks.addNote(task.id, "From the agent", "claude");
    await settle();
    expect(onBoard().hold?.waiting).toBe(2);

    await link(true);
    await sync();
    for (const side of [onBoard(), onRunner()]) {
      expect(side.status).toBe("in_progress");
      expect(side.phases[0]?.steps.map((s) => s.status)).toEqual(["done", "todo"]);
      expect(side.phases[0]?.steps[1]?.notes).toBe("Check the Windows run too");
      // The machine's order: the agent's note was there first.
      expect(types(side.events, "note").map((e) => e.payload.text)).toEqual(["From the agent", "From the board"]);
    }
    expect(onBoard().hold?.waiting).toBe(0);
    expect(board.db.prepare("SELECT COUNT(*) AS n FROM held_edits").get()).toEqual({ n: 0 });
  });

  it("names what it made the same on both sides, so a later edit can point at it", async () => {
    const { board, task, onBoard, onRunner, sync, link, settle } = await setup();
    await link(false);
    const phaseId = task.phases[0]!.id;
    const [added] = board.services.plans.addSteps(phaseId, [{ title: "Document it" }], "user");
    board.services.plans.updateStep(added!.id, { status: "done" }, "user");
    await settle();

    await link(true);
    await sync();
    const there = onRunner().phases[0]?.steps.find((s) => s.title === "Document it");
    expect(there).toMatchObject({ id: added!.id, status: "done" });
    expect(onBoard().phases[0]?.steps.map((s) => s.id)).toEqual(onRunner().phases[0]?.steps.map((s) => s.id));
    expect(onBoard().hold?.waiting).toBe(0);
  });

  it("is taken back, with the reason, when the machine refuses it as the task stands there", async () => {
    const { board, runner, task, write, test, onBoard, sync, link, settle, types } = await setup();
    await link(false);
    board.services.plans.updateStep(write.id, { status: "done" }, "user");
    // The agent rewrote the plan meanwhile: the step is gone.
    runner.services.plans.setPlan(
      task.id,
      { phases: [{ id: task.phases[0]!.id, title: "Build", steps: [{ id: test.id, title: "Test it" }] }] },
      "claude",
    );
    await settle();
    expect(onBoard().progress).toEqual({ done: 1, total: 2 });

    await link(true);
    await sync();
    const now = onBoard();
    expect(now.progress).toEqual({ done: 0, total: 1 });
    expect(now.hold?.waiting).toBe(0);
    expect(types(now.events, "edit_refused")[0]?.payload).toMatchObject({ edit: "plans.updateStep" });
    // The step the board marked done left no trace in the activity.
    expect(types(now.events, "step_updated")).toHaveLength(0);
  });

  it("keeps what is the board's own to itself", async () => {
    const { board, project, task, onBoard, onRunner, settle } = await setup();
    const epic = board.services.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    const elsewhere = board.services.projects.create({ title: "Elsewhere" });
    board.services.tasks.update(task.id, { epicId: epic.id }, "user");
    await settle();
    expect(onBoard().parent?.id).toBe(epic.id);
    expect(onBoard().hold?.waiting).toBe(0);
    expect(onRunner().parent).toBeNull();

    expect(() => board.services.tasks.update(task.id, { projectId: elsewhere.id }, "user")).toThrow(
      /is held by engine, so it can't be moved to another project; take it back first/,
    );
    expect(() => board.services.tasks.update(task.id, { archived: true }, "user")).toThrow(/can't be archived/);
    expect(() => board.services.tasks.delete([task.id], {}, "user")).toThrow(
      /is held by engine, so it can't be deleted/,
    );
    expect(() => board.services.projects.delete(project.id)).toThrow(/has tasks a machine holds/);
  });
});

describe("taking a task back by force", () => {
  it("doesn't wait for a machine that can't be reached, and that machine drops its copy when it is back", async () => {
    const { board, runner, task, onBoard, sync, link, settle } = await setup();
    await link(false);
    board.services.tasks.addNote(task.id, "Never mind", "user");
    await settle();
    await expect(board.integrations.machineSync.release(task.id, {}, "user")).rejects.toThrow(
      /couldn't be taken back from engine/,
    );

    const back = await board.integrations.machineSync.release(task.id, { force: true }, "user");
    expect(back.hold).toBeNull();
    expect(back.lastNote?.text).toBe("Never mind");
    expect(back.events.find((e) => e.type === "released")?.payload).toMatchObject({ forced: true });

    // What the machine did since is not the board's any more, and it is told to drop the task.
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    await link(true);
    await sync();
    expect(onBoard().status).toBe("planned");
    expect(runner.services.workingCopies.role(task.id)).toBeNull();
  });
});
