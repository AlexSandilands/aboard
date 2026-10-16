import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { AUTOPILOT_UNBLOCK_DEPENDENTS, unblockDependents } from "./unblockDependents.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup() {
  // The engine's clock is ours: boards are "now" for real, and the engine looks at them `daysLater` days on.
  let daysLater = 0;
  const h = createTestHarness({ integrations: { automations: [unblockDependents] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    now: () => new Date(Date.now() + daysLater * 86_400_000),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const task = (title: string, blockedBy: string[] = [], projectId = project.id) =>
    s.tasks.create({ projectId, title, plan, blockedBy });
  const finish = (id: string) => {
    s.tasks.move(id, { status: "done" }, "agent");
  };
  const pass = async (days = 0) => {
    daysLater = days;
    await engine.pass();
    await engine.idle();
  };
  const notices = () => s.notifications.list().items.filter((n) => n.kind === "autopilot_notice");
  const turnOn = (projectId = project.id) =>
    s.autopilot.setScope("project", projectId, AUTOPILOT_UNBLOCK_DEPENDENTS, { mode: "on" });
  return { ...h, s, project, other, task, finish, pass, notices, turnOn };
}

describe("unblock dependents", () => {
  it("notes and notifies once the only blocker is Done", async () => {
    const { s, task, finish, pass, notices, turnOn } = setup();
    const blocker = task("Blocker");
    const dependent = task("Dependent", [blocker.id]);
    turnOn();
    await pass();
    expect(notices()).toHaveLength(0);
    finish(blocker.id);
    await pass();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ taskId: dependent.id, title: `#${dependent.number} is unblocked` });
    expect(s.tasks.detail(dependent.id).events.find((e) => e.type === "note")).toMatchObject({
      actor: "autopilot",
      payload: { text: `Unblocked: #${blocker.number} finished` },
    });
    await pass();
    expect(notices()).toHaveLength(1);
  });

  it("waits until every blocker is Done, then gives one notification", async () => {
    const { task, finish, pass, notices, turnOn } = setup();
    const a = task("A");
    const b = task("B");
    task("Dependent", [a.id, b.id]);
    turnOn();
    finish(a.id);
    await pass();
    expect(notices()).toHaveLength(0);
    finish(b.id);
    await pass();
    expect(notices()).toHaveLength(1);
  });

  it("notifies again when a blocker is reopened and finished again", async () => {
    const { s, task, finish, pass, notices, turnOn } = setup();
    const blocker = task("Blocker");
    task("Dependent", [blocker.id]);
    turnOn();
    finish(blocker.id);
    await pass();
    s.tasks.move(blocker.id, { status: "in_progress" }, "agent");
    await pass();
    await new Promise((r) => setTimeout(r, 20));
    finish(blocker.id);
    await pass();
    expect(notices()).toHaveLength(2);
  });

  it("follows the dependent's project scope, across projects", async () => {
    const { task, other, project, finish, pass, notices, turnOn } = setup();
    const blocker = task("Blocker", [], other.id);
    task("Dependent", [blocker.id], project.id);
    turnOn(other.id);
    finish(blocker.id);
    await pass();
    expect(notices()).toHaveLength(0);
    turnOn(project.id);
    await pass();
    expect(notices()).toHaveLength(1);
  });

  it("only records a run in dry-run", async () => {
    const { s, project, task, finish, pass, notices, turnOn } = setup();
    const blocker = task("Blocker");
    task("Dependent", [blocker.id]);
    turnOn();
    s.autopilot.updateEngine({ dryRun: true });
    finish(blocker.id);
    await pass();
    expect(notices()).toHaveLength(0);
    expect(s.autopilot.runsForProject(project.id).some((r) => r.dryRun)).toBe(true);
  });

  it("ignores blockers finished long ago, and Done or archived dependents", async () => {
    const { s, task, finish, pass, notices, turnOn } = setup();
    const old = task("Old blocker");
    task("Dependent of old", [old.id]);
    finish(old.id);
    const b = task("Blocker");
    const done = task("Done dependent", [b.id]);
    const archived = task("Archived dependent", [b.id]);
    s.tasks.move(done.id, { status: "done" }, "agent");
    s.tasks.update(archived.id, { archived: true }, "user");
    finish(b.id);
    turnOn();
    await pass(2);
    expect(notices()).toHaveLength(0);
  });

  it("notifies when a blocker is closed as a duplicate", async () => {
    const { s, task, pass, notices, turnOn } = setup();
    const blocker = task("Blocker");
    const original = task("Original");
    const dependent = task("Dependent", [blocker.id]);
    turnOn();
    s.tasks.close(blocker.id, { resolution: "duplicate", byTaskId: original.id }, "agent");
    await pass();
    expect(notices()).toMatchObject([{ taskId: dependent.id }]);
  });
});
