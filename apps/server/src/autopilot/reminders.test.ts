import { UNSTICK_STALE_PREFIX, UNSTICK_WAITING_PREFIX } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "./engine.ts";

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
  const h = createTestHarness();
  const s = h.services;
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    now: () => new Date(Date.now() + later),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const working = (title = "Working", projectId = project.id) => {
    const task = s.tasks.create({ projectId, title, plan });
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
  const sent = (kind: "thread_waited" | "task_quiet" | "task_unblocked") =>
    s.notifications.list({ kind }).items.map((n) => n.title);
  const notes = (taskId: string) =>
    s.tasks
      .detail(taskId)
      .events.filter((e) => e.type === "note" && e.actor === "autopilot")
      .map((e) => (e.payload as { text: string }).text);
  return { ...h, s, project, other, working, withThread, pass, sent, notes };
}

describe("reminders", () => {
  describe("a quiet task", () => {
    it("tells you once the quiet period passes 24 h, and its own note doesn't end it", async () => {
      const { working, pass, sent, notes } = setup();
      const task = working();
      await pass(23 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([]);
      await pass(26 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([`#${task.number} has gone quiet`]);
      expect(notes(task.id)).toEqual([`${UNSTICK_STALE_PREFIX} 26h`]);
      // The Autopilot note isn't activity: the same quiet period is found again and dedupes.
      await pass(30 * HOUR_MS);
      expect(sent("task_quiet")).toHaveLength(1);
      expect(notes(task.id)).toHaveLength(1);
    });

    it("tells you again after new activity and another quiet period", async () => {
      const { s, working, pass, sent } = setup();
      const task = working();
      await pass(26 * HOUR_MS);
      await new Promise((r) => setTimeout(r, 5));
      s.tasks.addNote(task.id, "back at it", "agent");
      await pass(60 * HOUR_MS);
      expect(sent("task_quiet")).toHaveLength(2);
    });

    it("doesn't repeat what the retired Unstick automation reported, though its notice was never stored", async () => {
      const { s, working, pass, sent, notes } = setup();
      const task = working();
      const at = [s.tasks.lastActivityAt(task.id, "autopilot"), s.tasks.summary(task.id).statusChangedAt]
        .filter((a): a is string => a !== null)
        .sort()
        .at(-1)!;
      // An upgrade: the old automation ran for this quiet period, and left a run but no notification.
      s.autopilot.record({
        automation: "unstick",
        candidate: { dedupeKey: `stale:${task.id}:${at}`, summary: "flag", taskId: task.id },
        dryRun: false,
      });
      await pass(26 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([]);
      expect(notes(task.id)).toEqual([]);
    });

    it("is read once someone but Autopilot is active on the task again", async () => {
      const { s, working, pass } = setup();
      const task = working();
      await pass(26 * HOUR_MS);
      const unread = () => s.notifications.list({ kind: "task_quiet" }).items.filter((n) => n.readAt === null).length;
      expect(unread()).toBe(1);
      // Autopilot's own note doesn't end the quiet period.
      s.tasks.addNote(task.id, "bot note", "autopilot");
      expect(unread()).toBe(1);
      s.tasks.addNote(task.id, "back at it", "agent");
      expect(unread()).toBe(0);
    });

    it("is read by any other activity on the task, not only a note", async () => {
      const { s, working, pass } = setup();
      const task = working();
      await pass(26 * HOUR_MS);
      const unread = () => s.notifications.list({ kind: "task_quiet" }).items.filter((n) => n.readAt === null).length;
      expect(unread()).toBe(1);
      // An edit goes through the log, not addNote.
      s.tasks.update(task.id, { title: "Renamed" }, "user");
      expect(unread()).toBe(0);
    });

    it("leaves manual tasks, epics and tasks that aren't In Progress alone", async () => {
      const { s, project, working, pass, sent } = setup();
      s.tasks.update(working("Mine").id, { manual: true }, "user");
      s.tasks.create({ projectId: project.id, title: "planned", plan });
      await pass(48 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([]);
    });

    it("sends nothing while the setting is off, and reports what is still quiet once it is switched on", async () => {
      const { s, working, pass, sent, notes } = setup();
      const task = working();
      s.settings.update({ notifications: { kinds: { task_quiet: false } } });
      await pass(30 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([]);
      expect(notes(task.id)).toEqual([]);
      s.settings.update({ notifications: { kinds: { task_quiet: true } } });
      await pass(31 * HOUR_MS);
      expect(sent("task_quiet")).toHaveLength(1);
    });

    it("works in every project, with no Autopilot switch anywhere", async () => {
      const { other, working, pass, sent } = setup();
      const task = working("Elsewhere", other.id);
      await pass(26 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([`#${task.number} has gone quiet`]);
    });

    it("sends nothing in dry run, and catches up once it is off", async () => {
      const { s, working, pass, sent, notes } = setup();
      const task = working();
      s.autopilot.updateEngine({ dryRun: true });
      await pass(26 * HOUR_MS);
      expect(sent("task_quiet")).toEqual([]);
      expect(notes(task.id)).toEqual([]);
      s.autopilot.updateEngine({ dryRun: false });
      await pass(27 * HOUR_MS);
      expect(sent("task_quiet")).toHaveLength(1);
    });

    it("isn't held back by Pause all, which only stops runs", async () => {
      const { s, working, pass, sent } = setup();
      working();
      s.autopilot.setPaused(true);
      await pass(26 * HOUR_MS);
      expect(sent("task_quiet")).toHaveLength(1);
    });
  });

  describe("a thread waiting on you", () => {
    it("tells you once it has waited 30 min", async () => {
      const { working, withThread, pass, sent, notes } = setup();
      const task = working();
      withThread(task.id, "input");
      await pass(20 * MINUTE_MS);
      expect(sent("thread_waited")).toEqual([]);
      await pass(45 * MINUTE_MS);
      expect(sent("thread_waited")).toEqual([`#${task.number} is waiting for you`]);
      expect(notes(task.id)).toEqual([`${UNSTICK_WAITING_PREFIX} 45m`]);
      await pass(50 * MINUTE_MS);
      expect(sent("thread_waited")).toHaveLength(1);
    });

    it("is read when the thread stops waiting", async () => {
      const { s, working, pass } = setup();
      const task = working();
      s.links.add(task.id, { value: "t3code://threads/env/thread-1" }, "agent");
      const link = s.tasks.detail(task.id).links.at(-1)!;
      s.links.setSnapshot(link.id, { title: "T", status: "input", lastActivityAt: new Date().toISOString() });
      await pass(45 * MINUTE_MS);
      const unread = () =>
        s.notifications.list({ kind: "thread_waited" }).items.filter((n) => n.readAt === null).length;
      expect(unread()).toBe(1);
      s.links.setSnapshot(link.id, { title: "T", status: "working", lastActivityAt: new Date().toISOString() });
      expect(unread()).toBe(0);
    });

    it("doesn't tell you about a follow-up thread the user left waiting", async () => {
      const { s, working, pass, sent } = setup();
      const task = working();
      const link = s.links.add(task.id, { t3Thread: { environmentId: "env", threadId: "thread-ask" } }, "user", {
        role: "followup",
      });
      s.links.setSnapshot(link.id, { title: "Q", status: "input", lastActivityAt: new Date().toISOString() });
      await pass(2 * HOUR_MS);
      expect(sent("thread_waited")).toEqual([]);
    });

    it("ignores a thread that is working", async () => {
      const { working, withThread, pass, sent } = setup();
      withThread(working().id, "working");
      await pass(2 * HOUR_MS);
      expect(sent("thread_waited")).toEqual([]);
    });
  });

  describe("an unblocked task", () => {
    const blocked = (h: ReturnType<typeof setup>) => {
      const blocker = h.s.tasks.create({ projectId: h.project.id, title: "Blocker", plan });
      const dependent = h.s.tasks.create({
        projectId: h.project.id,
        title: "Dependent",
        plan,
        blockedBy: [blocker.id],
      });
      return { blocker, dependent };
    };

    it("is off by default, and tells you once its last blocker is Done once it is on", async () => {
      const h = setup();
      const { blocker, dependent } = blocked(h);
      h.s.tasks.move(blocker.id, { status: "done" }, "agent");
      await h.pass(0);
      expect(h.sent("task_unblocked")).toEqual([]);

      h.s.settings.update({ notifications: { kinds: { task_unblocked: true } } });
      await h.pass(1_000);
      expect(h.sent("task_unblocked")).toEqual([`#${dependent.number} is unblocked`]);
      expect(h.notes(dependent.id)).toEqual([`Unblocked: #${blocker.number} finished`]);
      await h.pass(2_000);
      expect(h.sent("task_unblocked")).toHaveLength(1);
    });

    it("says nothing about blockers that finished long ago", async () => {
      const h = setup();
      const { blocker } = blocked(h);
      h.s.settings.update({ notifications: { kinds: { task_unblocked: true } } });
      h.s.tasks.move(blocker.id, { status: "done" }, "agent");
      await h.pass(3 * 24 * HOUR_MS);
      expect(h.sent("task_unblocked")).toEqual([]);
    });
  });
});
