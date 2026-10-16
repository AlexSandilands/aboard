import type { PlanInput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const plan: PlanInput = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const task = (title: string, projectId = project.id) => s.tasks.create({ projectId, title, plan });
  return { ...h, s, project, other, task };
}

const expectCode = (fn: () => unknown, code: string, message?: RegExp) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (message) expect((error as AppError).message).toMatch(message);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("task relations", () => {
  it("stores 'a blocks b' once and shows it from both sides", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    const updated = s.tasks.update(b.id, { addBlockedBy: [`#${a.number}`] }, "agent");
    expect(updated.blockedBy).toEqual([{ id: a.id, number: a.number, title: "A", status: "planned", archived: false }]);
    expect(updated.blocked).toBe(true);
    const blocker = s.tasks.summary(a.id);
    expect(blocker.blocks).toEqual([{ id: b.id, number: b.number, title: "B", status: "planned", archived: false }]);
    expect(blocker.blocked).toBe(false);
    expect(updated.events.map((e) => e.type)).toContain("blocker_added");
    expect(s.tasks.detail(a.id).events.at(-1)).toMatchObject({
      type: "blocks_added",
      payload: { task: b.number, title: "B" },
    });
  });

  it("can set blockers when creating a task, and adding one twice changes nothing", () => {
    const { s, task, project } = setup();
    const a = task("A");
    const b = s.tasks.create({ projectId: project.id, title: "B", blockedBy: [a.id] });
    expect(b.blockedBy.map((t) => t.id)).toEqual([a.id]);
    const again = s.tasks.update(b.id, { addBlockedBy: [String(a.number)] }, "agent");
    expect(again.events.filter((e) => e.type === "blocker_added")).toHaveLength(1);
  });

  it("is blocked until every blocker is Done, whatever its resolution", () => {
    const { s, task } = setup();
    const a1 = task("A1");
    const a2 = task("A2");
    const b = task("B");
    s.tasks.update(b.id, { addBlockedBy: [a1.id, a2.id] }, "agent");
    s.tasks.move(a1.id, { status: "done" }, "agent");
    expect(s.tasks.summary(b.id).blocked).toBe(true);
    s.tasks.close(a2.id, { resolution: "wont_do" }, "user");
    expect(s.tasks.summary(b.id).blocked).toBe(false);
    s.tasks.move(a2.id, { status: "in_progress" }, "user");
    expect(s.tasks.summary(b.id).blocked).toBe(true);
  });

  it("keeps an archived, unfinished blocker blocking, and marks it archived", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    s.tasks.update(a.id, { archived: true }, "user");
    const after = s.tasks.summary(b.id);
    expect(after.blocked).toBe(true);
    expect(after.blockedBy[0]).toMatchObject({ id: a.id, archived: true });
  });

  it("works across projects and for epics", () => {
    const { s, task, other, project } = setup();
    const a = task("A");
    const b = task("B", other.id);
    const epic = s.tasks.create({ projectId: project.id, title: "Epic", kind: "epic" });
    s.tasks.update(b.id, { addBlockedBy: [a.id, epic.id] }, "agent");
    expect(s.tasks.summary(b.id).blockedBy.map((t) => t.id)).toEqual([a.id, epic.id]);
    expect(s.tasks.summary(epic.id).blocks.map((t) => t.id)).toEqual([b.id]);
    const blockedEpic = s.tasks.update(epic.id, { addBlockedBy: [a.id] }, "agent");
    expect(blockedEpic.blocked).toBe(true);
  });

  it("removes a relation from either task's point of view and ignores one that isn't there", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    const removed = s.tasks.update(b.id, { removeBlockedBy: [a.id] }, "agent");
    expect(removed.blockedBy).toEqual([]);
    expect(removed.blocked).toBe(false);
    expect(s.tasks.summary(a.id).blocks).toEqual([]);
    expect(s.tasks.detail(a.id).events.at(-1)?.type).toBe("blocks_removed");
    const events = s.tasks.detail(b.id).events.length;
    s.tasks.update(b.id, { removeBlockedBy: [a.id] }, "agent");
    expect(s.tasks.detail(b.id).events).toHaveLength(events);
  });

  it("rejects a task blocking itself", () => {
    const { s, task } = setup();
    const a = task("A");
    expectCode(() => s.tasks.update(a.id, { addBlockedBy: [a.id] }, "agent"), "VALIDATION", /cannot block itself/);
    expect(s.tasks.summary(a.id).blockedBy).toEqual([]);
  });

  it("rejects a cycle and spells out the chain", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    const c = task("C");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    s.tasks.update(c.id, { addBlockedBy: [b.id] }, "agent");
    // A blocks B blocks C, so C can't block A.
    expectCode(
      () => s.tasks.update(a.id, { addBlockedBy: [c.id] }, "agent"),
      "VALIDATION",
      new RegExp(
        `#${c.number} cannot block #${a.number}.*#${a.number} blocks #${b.number} blocks #${c.number} blocks #${a.number}`,
      ),
    );
    expectCode(() => s.tasks.update(b.id, { addBlockedBy: [a.id, b.id] }, "agent"), "VALIDATION", /itself/);
    expect(s.tasks.summary(a.id).blockedBy).toEqual([]);
  });

  it("is all or nothing when one blocker in a call is refused", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    const c = task("C");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    expectCode(() => s.tasks.update(a.id, { addBlockedBy: [c.id, b.id] }, "agent"), "VALIDATION", /cycle/);
    expect(s.tasks.summary(a.id).blockedBy).toEqual([]);
  });

  it("lets one call swap a blocker", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    const c = task("C");
    s.tasks.update(b.id, { removeBlockedBy: [a.id], addBlockedBy: [c.id] }, "agent");
    expect(s.tasks.summary(b.id).blockedBy.map((t) => t.id)).toEqual([c.id]);
  });

  it("refuses an archived task as either end", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    s.tasks.update(a.id, { archived: true }, "user");
    expectCode(() => s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent"), "VALIDATION", /archived/);
    expectCode(() => s.tasks.update(a.id, { addBlockedBy: [b.id] }, "agent"), "VALIDATION", /archived/);
    expect(s.tasks.summary(b.id).blockedBy).toEqual([]);
  });

  it("refuses an unknown task", () => {
    const { s, task } = setup();
    const a = task("A");
    expectCode(() => s.tasks.update(a.id, { addBlockedBy: ["#9999"] }, "agent"), "NOT_FOUND");
    expect(s.tasks.summary(a.id).blockedBy).toEqual([]);
  });

  it("drops the relation when either task is deleted, and says so in the other's log", () => {
    const { s, task } = setup();
    const a = task("A");
    const b = task("B");
    const c = task("C");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    s.tasks.update(c.id, { addBlockedBy: [b.id] }, "agent");
    s.tasks.update(b.id, { archived: true }, "user");
    s.tasks.delete(b.id, "user");
    expect(s.tasks.summary(a.id).blocks).toEqual([]);
    expect(s.tasks.summary(c.id).blockedBy).toEqual([]);
    expect(s.tasks.detail(a.id).events.at(-1)).toMatchObject({ type: "blocked_deleted" });
    expect(s.tasks.detail(c.id).events.at(-1)).toMatchObject({ type: "blocker_deleted" });
  });

  it("refreshes the cards of the tasks on the other end when one changes", () => {
    const { s, task, events } = setup();
    const a = task("A");
    const b = task("B");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    events.length = 0;
    s.tasks.move(a.id, { status: "done" }, "agent");
    const upserted = events.flatMap((e) => (e.type === "task.upserted" ? [e.task] : []));
    expect(upserted.find((t) => t.id === b.id)).toMatchObject({ blocked: false });
    events.length = 0;
    s.tasks.update(a.id, { title: "A renamed" }, "agent");
    const renamed = events.flatMap((e) => (e.type === "task.upserted" ? [e.task] : []));
    expect(renamed.find((t) => t.id === b.id)?.blockedBy[0]?.title).toBe("A renamed");
  });

  it("refreshes cards in other projects when a project is deleted", () => {
    const { s, task, other, events } = setup();
    const a = task("A", other.id);
    const b = task("B");
    s.tasks.update(b.id, { addBlockedBy: [a.id] }, "agent");
    events.length = 0;
    s.projects.delete(other.id);
    expect(s.tasks.summary(b.id).blockedBy).toEqual([]);
    expect(events.some((e) => e.type === "task.upserted" && e.task.id === b.id)).toBe(true);
  });

  it("goes through PATCH /api/tasks/:id", async () => {
    const { s, task, request } = setup();
    const a = task("A");
    const b = task("B");
    const res = await request(`/api/tasks/${b.id}`, { method: "PATCH", json: { addBlockedBy: [`#${a.number}`] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { blockedBy: unknown[] }).blockedBy).toHaveLength(1);
    const bad = await request(`/api/tasks/${a.id}`, { method: "PATCH", json: { addBlockedBy: [b.id] } });
    expect(bad.status).toBe(400);
    expect(s.tasks.summary(a.id).blockedBy).toEqual([]);
  });
});
