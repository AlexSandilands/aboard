import type { PrSnapshot } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import { AUTOPILOT_AUTO_ARCHIVE, autoArchive } from "./autoArchive.ts";

const plan = { phases: [{ title: "Do", steps: [{ title: "it" }] }] };
const DAY_MS = 86_400_000;

const pr = (state: PrSnapshot["state"]): PrSnapshot => ({
  state,
  title: "Change",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/x",
  updatedAt: null,
});

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

function setup() {
  // The clock is ours: tasks are "done" for real now, and the engine looks at them `daysLater` days on.
  let daysLater = 0;
  const h = createTestHarness({ integrations: { automations: [autoArchive] } });
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    now: () => new Date(Date.now() + daysLater * DAY_MS),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const done = (title = "Done one", links: string[] = []) => {
    const task = s.tasks.create({ projectId: project.id, title, plan, links: links.map((value) => ({ value })) });
    s.tasks.move(task.id, { status: "done" }, "agent");
    return task;
  };
  const pass = async (days: number) => {
    daysLater = days;
    await engine.pass();
    await engine.idle();
  };
  const archived = (id: string) => s.tasks.summary(id).archivedAt !== null;
  const turnOn = (config?: Record<string, unknown>) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_AUTO_ARCHIVE, { mode: "on", ...(config ? { config } : {}) });
  return { ...h, s, project, done, pass, archived, turnOn };
}

describe("auto-archive Done", () => {
  it("archives a task past 14 days by default, as autopilot, with a note", async () => {
    const { s, done, pass, archived, turnOn } = setup();
    const task = done();
    turnOn();
    await pass(15);
    expect(archived(task.id)).toBe(true);
    const events = s.tasks.detail(task.id).events;
    expect(events.find((e) => e.type === "archived")?.actor).toBe("autopilot");
    expect(events.find((e) => e.type === "note")).toMatchObject({
      actor: "autopilot",
      payload: { text: "Archived by Autopilot after 14 days in Done" },
    });
  });

  it("leaves younger tasks, archived tasks and tasks outside Done alone", async () => {
    const { s, project, done, pass, archived, turnOn } = setup();
    const young = done("young");
    turnOn({ days: 30 });
    const open = s.tasks.create({ projectId: project.id, title: "open", plan });
    const gone = done("gone");
    s.tasks.update(gone.id, { archived: true }, "user");
    await pass(20);
    expect(archived(young.id)).toBe(false);
    expect(archived(open.id)).toBe(false);
    await pass(40);
    expect(archived(young.id)).toBe(true);
    expect(archived(open.id)).toBe(false);
    // Already archived by someone else: no run for it.
    expect(s.autopilot.runsForTask(gone.id)).toEqual([]);
  });

  describe("finished epics", () => {
    const epicOf = (h: ReturnType<typeof setup>, titles = ["one", "two"]) => {
      const tasks = titles.map((t) => h.done(t));
      const taskIds = tasks.map((t) => t.id);
      const epic = h.s.tasks.createEpic({ projectId: h.project.id, title: "Epic" }, taskIds, "agent");
      return { epic, tasks };
    };
    const scope = (
      h: ReturnType<typeof setup>,
      epicId: string,
      input: { mode: "on" | "off"; config?: Record<string, unknown> },
    ) => h.s.autopilot.setScope("epic", epicId, AUTOPILOT_AUTO_ARCHIVE, input, h.project.id);

    it("archives the epic with its tasks together after the days, leaving it Done", async () => {
      const h = setup();
      const { s, pass, archived, turnOn } = h;
      const { epic, tasks } = epicOf(h);
      const all = [epic.id, ...tasks.map((t) => t.id)];
      turnOn();
      await pass(10);
      expect(all.map(archived)).toEqual([false, false, false]);
      await pass(15);
      expect(all.map(archived)).toEqual([true, true, true]);
      // Never through Backlog: the only status change on the epic is the one that made it Done.
      const events = s.tasks.detail(epic.id).events;
      expect(events.filter((e) => e.type === "status_changed").map((e) => e.payload)).toMatchObject([
        { to: "done", fromChildren: true },
      ]);
      expect(s.tasks.summary(epic.id).status).toBe("done");
      expect(events.find((e) => e.type === "archived")?.actor).toBe("autopilot");
      expect(events.find((e) => e.type === "note")).toMatchObject({
        actor: "autopilot",
        payload: { text: "Archived by Autopilot with its 2 tasks after 14 days in Done" },
      });
      expect(s.tasks.detail(tasks[0]!.id).events.find((e) => e.type === "archived")?.actor).toBe("autopilot");
    });

    it("includes tasks already archived, and leaves an epic with an open task alone", async () => {
      const h = setup();
      const { s, project, done, pass, archived, turnOn } = h;
      const { epic, tasks } = epicOf(h);
      s.tasks.update(tasks[0]!.id, { archived: true }, "user");
      const open = s.tasks.create({ projectId: project.id, title: "open", plan });
      const busy = s.tasks.createEpic(
        { projectId: project.id, title: "Busy" },
        [open.id, done("finished").id],
        "agent",
      );
      turnOn();
      await pass(15);
      expect(archived(epic.id)).toBe(true);
      expect(archived(tasks[1]!.id)).toBe(true);
      expect(archived(busy.id)).toBe(false);
      expect(archived(open.id)).toBe(false);
      expect(s.tasks.summaries({ epicId: busy.id }).some((t) => t.archivedAt !== null)).toBe(false);
    });

    it("waits for an unmerged PR on the epic or one of its tasks", async () => {
      const h = setup();
      const { s, project, pass, archived, turnOn } = h;
      const prTask = s.tasks.create({
        projectId: project.id,
        title: "with pr",
        plan,
        links: [{ value: "https://github.com/acme/app/pull/7" }],
      });
      s.tasks.move(prTask.id, { status: "done" }, "agent");
      const byTask = s.tasks.createEpic({ projectId: project.id, title: "Task PR" }, [prTask.id], "agent");
      const own = epicOf(h, ["x"]);
      s.links.add(own.epic.id, { value: "https://github.com/acme/app/pull/8" }, "agent");
      turnOn();
      await pass(15);
      expect([byTask.id, own.epic.id].map(archived)).toEqual([false, false]);
      for (const taskId of [prTask.id, own.epic.id]) {
        s.links.setSnapshot(s.links.listByKind("pr").find((l) => l.taskId === taskId)!.id, pr("merged"));
      }
      await pass(16);
      expect([byTask.id, own.epic.id].map(archived)).toEqual([true, true]);
    });

    it("stays unarchived after a manual unarchive, until the epic leaves Done and comes back", async () => {
      const h = setup();
      const { s, pass, archived, turnOn } = h;
      const { epic, tasks } = epicOf(h);
      turnOn();
      await pass(15);
      s.tasks.update(epic.id, { archived: false }, "user");
      await pass(16);
      expect(archived(epic.id)).toBe(false);
      // A new open task takes it out of Done; finishing it puts it back, and the clock starts again.
      const extra = s.tasks.create({ projectId: h.project.id, title: "extra", plan, epicId: epic.id });
      expect(s.tasks.summary(epic.id).status).toBe("planned");
      s.tasks.move(extra.id, { status: "done" }, "agent");
      expect(s.tasks.summary(epic.id).status).toBe("done");
      await pass(10);
      expect(archived(epic.id)).toBe(false);
      await pass(15);
      expect(archived(epic.id)).toBe(true);
      expect(archived(extra.id)).toBe(true);
      expect(tasks.map((t) => archived(t.id))).toEqual([true, true]);
    });

    it("follows the epic's own setting: its own days, or off while the project is on", async () => {
      const h = setup();
      const { pass, archived, turnOn } = h;
      const fast = epicOf(h, ["a"]);
      const off = epicOf(h, ["b"]);
      const slow = epicOf(h, ["c"]);
      turnOn();
      scope(h, fast.epic.id, { mode: "on", config: { days: 3 } });
      scope(h, off.epic.id, { mode: "off" });
      scope(h, slow.epic.id, { mode: "on", config: { days: 60 } });
      await pass(20);
      expect([fast, off, slow].map((e) => archived(e.epic.id))).toEqual([true, false, false]);
    });

    it("archives an epic that is on by itself while its project is off", async () => {
      const h = setup();
      const { pass, archived } = h;
      const { epic, tasks } = epicOf(h);
      scope(h, epic.id, { mode: "on", config: { days: 3 } });
      await pass(5);
      expect([epic.id, ...tasks.map((t) => t.id)].map(archived)).toEqual([true, true, true]);
    });

    it("only previews in dry-run", async () => {
      const h = setup();
      const { s, project, pass, archived, turnOn } = h;
      const { epic, tasks } = epicOf(h);
      s.autopilot.updateEngine({ dryRun: true });
      turnOn();
      await pass(15);
      expect([epic.id, ...tasks.map((t) => t.id)].map(archived)).toEqual([false, false, false]);
      expect(s.autopilot.runsForProject(project.id)).toMatchObject([
        {
          status: "skipped",
          dryRun: true,
          summary: `Would archive #${epic.number} with its 2 tasks after 14 days in Done`,
        },
      ]);
    });
  });

  it("uses each project's own number of days", async () => {
    const { s, done, pass, archived, turnOn } = setup();
    const task = done();
    turnOn({ days: 30 });
    const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
    const b = s.tasks.create({ projectId: other.id, title: "b", plan });
    s.tasks.move(b.id, { status: "done" }, "agent");
    s.autopilot.setScope("project", other.id, AUTOPILOT_AUTO_ARCHIVE, { mode: "on", config: { days: 3 } });
    await pass(5);
    expect(archived(task.id)).toBe(false);
    expect(archived(b.id)).toBe(true);
  });

  it("waits for an open PR but not a merged or closed one", async () => {
    const { s, done, pass, archived, turnOn } = setup();
    const withPr = (n: number) => done(`pr ${n}`, [`https://github.com/acme/app/pull/${n}`]);
    const open = withPr(1);
    const merged = withPr(2);
    const closed = withPr(3);
    const unknown = withPr(4);
    const draft = withPr(5);
    for (const [task, state] of [
      [open, "open"],
      [draft, "draft"],
      [merged, "merged"],
      [closed, "closed"],
    ] as const) {
      s.links.setSnapshot(s.links.listByKind("pr").find((l) => l.taskId === task.id)!.id, pr(state));
    }
    turnOn();
    await pass(15);
    expect([open, draft, merged, closed, unknown].map((t) => archived(t.id))).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  it("doesn't archive again after a manual unarchive, until the task returns to Done", async () => {
    const { s, done, pass, archived, turnOn } = setup();
    const task = done();
    turnOn();
    await pass(15);
    s.tasks.update(task.id, { archived: false }, "user");
    await pass(16);
    expect(archived(task.id)).toBe(false);

    s.tasks.move(task.id, { status: "review" }, "user");
    s.tasks.move(task.id, { status: "done" }, "user");
    await pass(10);
    expect(archived(task.id)).toBe(false);
    await pass(15);
    expect(archived(task.id)).toBe(true);
  });

  it("only previews in dry-run, and does nothing while off", async () => {
    const { s, project, done, pass, archived, turnOn } = setup();
    const task = done();
    await pass(15);
    expect(archived(task.id)).toBe(false);
    expect(s.autopilot.runsForProject(project.id)).toEqual([]);

    s.autopilot.updateEngine({ dryRun: true });
    turnOn();
    await pass(15);
    expect(archived(task.id)).toBe(false);
    expect(s.autopilot.runsForProject(project.id)).toMatchObject([
      { status: "skipped", dryRun: true, summary: `Would archive #${task.number} after 14 days in Done` },
    ]);
  });
});
