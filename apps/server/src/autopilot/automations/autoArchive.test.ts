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

  it("leaves younger tasks, epics, archived tasks and tasks outside Done alone", async () => {
    const { s, project, done, pass, archived, turnOn } = setup();
    const young = done("young");
    turnOn({ days: 30 });
    const open = s.tasks.create({ projectId: project.id, title: "open", plan });
    const child = done("child");
    const epic = s.tasks.createEpic({ projectId: project.id, title: "Epic" }, [child.id], "agent");
    const gone = done("gone");
    s.tasks.update(gone.id, { archived: true }, "user");
    await pass(20);
    expect(archived(young.id)).toBe(false);
    expect(archived(open.id)).toBe(false);
    expect(archived(epic.id)).toBe(false);
    expect(archived(child.id)).toBe(false);
    await pass(40);
    expect(archived(young.id)).toBe(true);
    expect(archived(open.id)).toBe(false);
    expect(archived(epic.id)).toBe(false);
    // Archiving the children would send a finished epic back to Backlog.
    expect(archived(child.id)).toBe(false);
    expect(s.tasks.summary(epic.id).status).toBe("done");
    // Already archived by someone else: no run for it.
    expect(s.autopilot.runsForTask(gone.id)).toEqual([]);
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
