import { afterEach, describe, expect, it } from "vitest";
import { createBoardAndRunner } from "../../test/boardAndRunner.ts";
import { createTestHarness } from "../../test/harness.ts";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function setup(options: Parameters<typeof createBoardAndRunner>[0] = {}) {
  const pair = await createBoardAndRunner(options);
  stops.push(pair.stop);
  const { board } = pair;
  const project = board.services.projects.create({ title: "App", workspaceRoot: "/work/app" });
  const task = board.services.tasks.create({
    projectId: project.id,
    title: "Ship the thing",
    description: "All of it",
    labels: ["backend"],
    plan: { phases: [{ title: "Build", steps: [{ title: "Write it" }, { title: "Test it" }] }] },
  });
  return { ...pair, project, task };
}

describe("handing a task to a machine", () => {
  it("gives the machine a working copy under the board's ids and records who holds it", async () => {
    const { board, runner, machine, task, cloned } = await setup({
      remotes: { "/work/app": "git@github.com:acme/app.git" },
    });
    board.services.tasks.addNote(task.id, "Start with the parser", "user");
    const held = await board.integrations.machineSync.handOver(task.id, machine.id, "user");

    expect(held.hold).toMatchObject({ machineId: machine.id, machineName: "engine", waiting: 0 });
    expect(cloned).toEqual([
      { url: "git@github.com:acme/app.git", dir: expect.stringContaining("github.com-acme-app") },
    ]);
    const copy = runner.services.tasks.detail(task.id);
    expect(copy).toMatchObject({
      number: task.number,
      title: "Ship the thing",
      description: "All of it",
      status: "planned",
    });
    expect(copy.labels).toEqual(["backend"]);
    expect(copy.phases[0]?.steps.map((s) => s.id)).toEqual(task.phases[0]?.steps.map((s) => s.id));
    expect(copy.events.some((e) => e.type === "note" && e.payload.text === "Start with the parser")).toBe(true);
    expect(runner.services.workingCopies.role(task.id)).toBe("held");
    expect(runner.services.projects.get(copy.projectId).title).toBe("App");
  });

  it("applies what an agent does on the machine, live and in order", async () => {
    const { board, runner, machine, task, sync } = await setup();
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    board.events.length = 0;

    const step = task.phases[0]!.steps[0]!;
    runner.services.tasks.move(task.id, { status: "in_progress" }, "claude");
    runner.services.plans.updateStep(step.id, { status: "done", notes: "Parser first" }, "claude");
    runner.services.tasks.addNote(task.id, "Halfway", "claude");
    const result = await sync();

    expect(result.applied).toBe(3);
    const now = board.services.tasks.detail(task.id);
    expect(now.status).toBe("in_progress");
    expect(now.phases[0]?.steps[0]).toMatchObject({ status: "done", notes: "Parser first" });
    expect(now.lastNote).toMatchObject({ text: "Halfway", actor: "claude" });
    expect(now.events.filter((e) => e.type === "status_changed").map((e) => e.actor)).toEqual(["claude"]);
    // The browser hears of it as of any local change.
    expect(board.events.some((e) => e.type === "task.upserted" && e.task.id === task.id)).toBe(true);
  });

  it("takes a task back with its last changes, and the machine drops its copy", async () => {
    const { board, runner, machine, task } = await setup();
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    runner.services.tasks.move(task.id, { status: "review" }, "claude");

    const back = await board.integrations.machineSync.release(task.id, {}, "user");
    expect(back.hold).toBeNull();
    expect(back.status).toBe("review");
    expect(back.events.map((e) => e.type)).toContain("released");
    expect(runner.services.workingCopies.role(task.id)).toBeNull();
    expect(() => runner.services.tasks.detail(task.id)).toThrow(/not found/i);
  });

  it("clones a project's repository once, and knows it by its remote whatever the paths", async () => {
    const { board, runner, machine, project, task, cloned } = await setup({
      remotes: { "/work/app": "https://github.com/Acme/App.git" },
    });
    const second = board.services.tasks.create({ projectId: project.id, title: "And another" });
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    await board.integrations.machineSync.handOver(second.id, machine.id, "user");

    expect(cloned).toHaveLength(1);
    const there = runner.services.projects.get(runner.services.tasks.summary(second.id).projectId);
    // The runner's own folder under its data dir, not the board's path.
    expect(there.workspaceRoot).toBe(cloned[0]?.dir);
    expect(there.workspaceRoot).not.toBe("/work/app");
    expect(runner.services.tasks.summary(task.id).projectId).toBe(there.id);
  });

  it("says so when the machine can't reach the repository, and hands nothing over", async () => {
    const { board, runner, machine, task } = await setup({
      remotes: { "/work/app": "git@github.com:acme/private.git" },
      clone: () =>
        Promise.resolve({ code: 128, stdout: "", stderr: "Cloning...\nfatal: Could not read from remote repository." }),
    });
    await expect(board.integrations.machineSync.handOver(task.id, machine.id, "user")).rejects.toThrow(
      "engine can't clone git@github.com:acme/private.git: fatal: Could not read from remote repository.",
    );
    expect(board.services.tasks.summary(task.id).hold).toBeNull();
    expect(runner.services.workingCopies.role(task.id)).toBeNull();
  });

  it("clones nothing from a URL that isn't a repository on a host", async () => {
    const { board, runner, machine, task, cloned } = await setup({ remotes: { "/work/app": "ext::sh@evil:run" } });
    await expect(board.integrations.machineSync.handOver(task.id, machine.id, "user")).rejects.toThrow(
      "ext::sh@evil:run isn't a repository URL this machine can clone",
    );
    expect(cloned).toEqual([]);
    expect(runner.services.workingCopies.role(task.id)).toBeNull();
    const project = { id: "p", title: "P", remote: "evil/run" };
    const { checkouts } = runner.integrations.runnerHost;
    await expect(checkouts.ensure({ ...project, remoteUrl: "--upload-pack=x@evil:run" })).rejects.toThrow(
      /isn't a repository URL/,
    );
  });

  it("names the clone's folder from the URL it clones, whatever the request calls the repository", async () => {
    const { runner, cloned } = await setup();
    const { checkouts } = runner.integrations.runnerHost;
    const dir = await checkouts.ensure({
      id: "p",
      title: "P",
      remote: "../..",
      remoteUrl: "git@github.com:acme/app.git",
    });
    expect(dir).toMatch(/[/\\]github\.com-acme-app$/);
    expect(cloned.at(-1)).toEqual({ url: "git@github.com:acme/app.git", dir });
  });

  it("refuses what can't be handed over", async () => {
    const { board, machine, project, task } = await setup();
    const epic = board.services.tasks.create({ projectId: project.id, title: "Big", kind: "epic" });
    const manual = board.services.tasks.create({ projectId: project.id, title: "Sign off", manual: true });
    const handOver = (id: string) => board.integrations.machineSync.handOver(id, machine.id, "user");
    await expect(handOver(epic.id)).rejects.toThrow(/is an epic/);
    await expect(handOver(manual.id)).rejects.toThrow(/manual task/);
    await handOver(task.id);
    await expect(handOver(task.id)).rejects.toThrow(/already held by engine/);
  });
});

describe("a held task and backups", () => {
  it("leaves who holds it out of the backup, so a restore brings back a task the board holds itself", async () => {
    const { board, machine, task } = await setup();
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    board.services.tasks.addNote(task.id, "Waiting for the machine", "user");

    const dump = board.services.backup.dump();
    const text = JSON.stringify(dump);
    expect(text).not.toContain(machine.id);
    expect(text).not.toContain("task_holds");
    expect(text).not.toContain("held_edits");
    expect(dump.tasks.find((b) => b.task.id === task.id)?.task).not.toHaveProperty("hold");
  });

  it("can't be moved to another board while a machine holds it", async () => {
    const { board, machine, project, task } = await setup();
    await board.integrations.machineSync.handOver(task.id, machine.id, "user");
    expect(board.services.backup.busyTaskIds()).toContain(task.id);

    const other = createTestHarness();
    const there = other.services.projects.create({ title: "App" });
    const [moved] = other.services.backup.importTasks(board.services.backup.dump(), [task.id], {
      mode: "move",
      projectMap: { [project.id]: there.id },
      source: { folder: "desk", instanceId: board.instanceId },
      machineName: "laptop",
      info: { remotes: {}, busyTaskIds: board.services.backup.busyTaskIds() },
      remotes: new Map(),
      attachmentsFrom: null,
      actor: "user",
    });
    expect(moved).toMatchObject({
      ok: false,
      error: expect.stringMatching(/or a machine held it, at desk's last backup/),
    });
    expect(() => other.services.tasks.detail(task.id)).toThrow(/not found/i);
  });

  it("restores a machine-numbered task by its own number, never the board's task of the same digits", () => {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "App" });
    const own = h.services.tasks.create({ projectId: project.id, title: "The board's #1" });
    const made = h.services.tasks.create(
      { projectId: project.id, title: "The machine's #E1" },
      { number: { prefix: "E", number: 1 } },
    );
    expect(own.number).toBe(1);
    const dump = h.services.backup.dump();
    h.services.tasks.delete([made.id], {}, "user");
    h.services.tasks.purge([made.id], "user");

    expect(h.services.backup.diff(dump).tasks.map((t) => t.number)).toEqual(["E1"]);
    expect(h.services.backup.restoreTask(dump, "E1", { actor: "user" })).toEqual({ taskId: made.id, number: "E1" });
    expect(h.services.tasks.summary(made.id)).toMatchObject({ number: 1, numberPrefix: "E" });
    expect(h.services.tasks.summary(own.id).title).toBe("The board's #1");
    // And the other way round: the board's #1 is still on the board, so restoring it is refused.
    expect(() => h.services.backup.restoreTask(dump, 1, { actor: "user" })).toThrow(/still on the board/);
  });
});
