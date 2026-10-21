import { epicBranchName, type PlanInput } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const plan = (...titles: string[]): PlanInput => ({
  phases: [{ title: "Build", steps: titles.map((title) => ({ title })) }],
});

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
  const epic = s.tasks.create({ projectId: project.id, title: "Storefront Revamp", kind: "epic" });
  const child = (title: string) => s.tasks.create({ projectId: project.id, title, epicId: epic.id, plan: plan("a") });
  return { ...h, s, project, other, epic, child };
}

afterEach(() => {
  vi.useRealTimers();
});

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

describe("archiving a finished epic", () => {
  it("archives the epic with its unarchived tasks and keeps it Done", () => {
    const { s, epic, child } = setup();
    const [a, b] = [child("A"), child("B")];
    s.tasks.move(a.id, { status: "done" }, "agent");
    s.tasks.move(b.id, { status: "done" }, "agent");
    const done = s.tasks.summary(epic.id);
    expect(s.tasks.archiveFinishedEpic(epic.id, "autopilot")).toBe(2);
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "done", position: done.position });
    expect([epic.id, a.id, b.id].map((id) => s.tasks.summary(id).archivedAt !== null)).toEqual([true, true, true]);
  });

  it("refuses a task that isn't an epic, an archived epic, an open task and an epic that isn't Done", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    expect(() => s.tasks.archiveFinishedEpic(a.id, "autopilot")).toThrow(/not an epic/);
    expect(() => s.tasks.archiveFinishedEpic(epic.id, "autopilot")).toThrow(/open tasks/);
    s.tasks.move(a.id, { status: "done" }, "agent");
    s.tasks.update(a.id, { archived: true }, "user");
    // No unarchived tasks left: Backlog by derivation, so not finished.
    expect(() => s.tasks.archiveFinishedEpic(epic.id, "autopilot")).toThrow(/isn't finished/);
    s.tasks.update(a.id, { archived: false }, "user");
    s.tasks.archiveFinishedEpic(epic.id, "autopilot");
    expect(() => s.tasks.archiveFinishedEpic(epic.id, "autopilot")).toThrow(/already archived/);
  });
});

describe("epics", () => {
  it("creates an empty epic in Backlog with an empty roll-up", () => {
    const { epic } = setup();
    expect(epic).toMatchObject({ kind: "epic", status: "backlog", parent: null, children: [] });
    expect(epic.rollup).toEqual({
      total: 0,
      done: 0,
      byStatus: { backlog: 0, planned: 0, in_progress: 0, review: 0, done: 0 },
    });
  });

  it("puts a child in an epic at creation and derives the epic's status from it", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    expect(a.parent).toEqual({ id: epic.id, number: epic.number, title: "Storefront Revamp" });
    expect(a.rollup).toBeNull();
    const after = s.tasks.detail(epic.id);
    expect(after.status).toBe("planned");
    expect(after.rollup).toMatchObject({ total: 1, done: 0, byStatus: { planned: 1 } });
    expect(after.children.map((c) => c.id)).toEqual([a.id]);
    expect(after.events.map((e) => e.type)).toEqual(["created", "child_added", "status_changed"]);
    expect(after.events.at(-1)?.payload).toEqual({ from: "backlog", to: "planned", fromChildren: true });
  });

  it("sits where its furthest-back open child is, and is done when every child is done or closed", () => {
    const { s, epic, child } = setup();
    s.settings.update({ autoReview: false });
    const a = child("A");
    const b = child("B");
    s.tasks.move(a.id, { status: "review" }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("planned");
    s.tasks.move(b.id, { status: "in_progress" }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("in_progress");
    s.tasks.move(b.id, { status: "done" }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("review");
    s.tasks.close(a.id, { resolution: "wont_do" }, "user");
    const done = s.tasks.summary(epic.id);
    expect(done.status).toBe("done");
    expect(done.rollup).toMatchObject({ total: 2, done: 2 });
    // Reopening a child brings the epic back.
    s.tasks.move(a.id, { status: "in_progress" }, "user");
    expect(s.tasks.summary(epic.id).status).toBe("in_progress");
  });

  it("ignores archived children and goes back to Backlog when it has none", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    const b = child("B");
    s.tasks.move(b.id, { status: "done" }, "agent");
    s.tasks.update(a.id, { archived: true }, "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "done", rollup: { total: 1, done: 1 } });
    s.tasks.update(b.id, { epicId: null }, "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "backlog", rollup: { total: 0 } });
    // The detail still lists the archived child.
    expect(s.tasks.detail(epic.id).children.map((c) => c.id)).toEqual([a.id]);
  });

  it("attaches, moves between and detaches from epics, logging on every side", () => {
    const { s, project, epic } = setup();
    const second = s.tasks.create({ projectId: project.id, title: "Second", kind: "epic" });
    const task = s.tasks.create({ projectId: project.id, title: "Loose", plan: plan("a") });
    s.tasks.update(task.id, { epicId: `#${epic.number}` }, "agent");
    expect(s.tasks.summary(task.id).parent?.id).toBe(epic.id);
    s.tasks.update(task.id, { epicId: String(second.number) }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("backlog");
    expect(s.tasks.summary(second.id).status).toBe("planned");
    s.tasks.update(task.id, { epicId: null }, "agent");
    expect(s.tasks.summary(task.id).parent).toBeNull();
    const log = s.tasks.detail(task.id).events.filter((e) => e.type === "epic_changed");
    expect(log.map((e) => e.payload)).toEqual([
      { from: null, to: epic.number },
      { from: epic.number, to: second.number },
      { from: second.number, to: null },
    ]);
    expect(s.tasks.detail(epic.id).events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["child_added", "child_removed"]),
    );
  });

  it("refuses a parent that is not an epic, is archived, or is in another project", () => {
    expect.hasAssertions();
    const { s, project, other, epic } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "T" });
    const loose = s.tasks.create({ projectId: project.id, title: "Loose" });
    expectCode(() => s.tasks.update(task.id, { epicId: loose.id }, "user"), "VALIDATION", /not an epic/);
    expectCode(
      () => s.tasks.create({ projectId: other.id, title: "Elsewhere", epicId: epic.id }),
      "VALIDATION",
      /another project/,
    );
    expectCode(() => s.tasks.update(task.id, { epicId: "#999" }, "user"), "NOT_FOUND");
    s.tasks.update(epic.id, { archived: true }, "user");
    expectCode(() => s.tasks.update(task.id, { epicId: epic.id }, "user"), "VALIDATION", /archived/);
  });

  it("doesn't nest epics", () => {
    expect.hasAssertions();
    const { s, project, epic } = setup();
    expectCode(
      () => s.tasks.create({ projectId: project.id, title: "Inner", kind: "epic", epicId: epic.id }),
      "VALIDATION",
      /nest/,
    );
    const inner = s.tasks.create({ projectId: project.id, title: "Inner", kind: "epic" });
    expectCode(() => s.tasks.update(inner.id, { epicId: epic.id }, "user"), "VALIDATION", /nest/);
  });

  it("gives an epic no plan, no status moves, no closing and no reviews", () => {
    expect.hasAssertions();
    const { s, project, epic } = setup();
    expectCode(
      () => s.tasks.create({ projectId: project.id, title: "E", kind: "epic", plan: plan("a") }),
      "VALIDATION",
      /no plan/,
    );
    expectCode(() => s.plans.setPlan(epic.id, plan("a"), "agent"), "VALIDATION", /no plan/);
    expectCode(() => s.plans.addPhase(epic.id, "P", "agent"), "VALIDATION", /no plan/);
    expectCode(() => s.tasks.move(epic.id, { status: "planned" }, "user"), "VALIDATION", /follows its child/);
    expectCode(() => s.tasks.close(epic.id, { resolution: "wont_do" }, "user"), "VALIDATION", /epic/);
    expectCode(() => s.reviews.openRound(epic.id, { trigger: "manual", actor: "user" }), "VALIDATION", /epic/);
  });

  it("reorders an epic within its column", () => {
    const { s, project, epic } = setup();
    const later = s.tasks.create({ projectId: project.id, title: "Later", kind: "epic" });
    s.tasks.move(later.id, { beforeId: epic.id }, "user");
    const lane = s.tasks.summaries({ projectId: project.id, status: "backlog" }).map((t) => t.id);
    expect(lane.indexOf(later.id)).toBeLessThan(lane.indexOf(epic.id));
  });

  it("detaches a child moved to another project, unless given an epic there", () => {
    const { s, other, epic, child } = setup();
    const a = child("A");
    s.tasks.update(a.id, { projectId: other.id }, "user");
    expect(s.tasks.summary(a.id).parent).toBeNull();
    expect(s.tasks.summary(epic.id).rollup?.total).toBe(0);

    const there = s.tasks.create({ projectId: other.id, title: "There", kind: "epic" });
    const b = child("B");
    s.tasks.update(b.id, { projectId: other.id, epicId: there.id }, "user");
    expect(s.tasks.summary(b.id).parent?.id).toBe(there.id);
  });

  it("takes its children along when the epic moves to another project", () => {
    const { s, other, epic, child } = setup();
    const a = child("A");
    s.tasks.update(epic.id, { projectId: other.id }, "user");
    expect(s.tasks.summary(a.id)).toMatchObject({ projectId: other.id, parent: { id: epic.id } });
    expect(s.tasks.detail(a.id).events.at(-1)).toMatchObject({
      type: "moved_project",
      payload: { withEpic: epic.number },
    });
  });

  it("leaves children loose when the epic is deleted, and updates the epic when a child is", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    const b = child("B");
    s.tasks.update(b.id, { archived: true }, "user");
    s.tasks.delete(b.id, "user");
    expect(s.tasks.detail(epic.id).events.at(-1)).toMatchObject({
      type: "child_removed",
      payload: { deleted: true },
    });

    s.tasks.move(a.id, { status: "done" }, "user");
    s.tasks.update(epic.id, { archived: true }, "user");
    s.tasks.delete(epic.id, "user");
    expect(s.tasks.summary(a.id).parent).toBeNull();
    expect(s.tasks.detail(a.id).events.at(-1)).toMatchObject({
      type: "epic_changed",
      payload: { epicDeleted: true },
    });
  });

  it("doesn't move an epic to Done when its own PR merges", () => {
    const { s, epic, child } = setup();
    s.settings.update({ autoReview: false });
    const a = child("A");
    s.tasks.move(a.id, { status: "review" }, "agent");
    const link = s.links.add(epic.id, { value: "https://github.com/acme/app/pull/1" }, "agent");
    s.links.setSnapshot(link.id, {
      state: "merged",
      title: "x",
      checks: "passing",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: null,
      updatedAt: null,
    });
    expect(s.tasks.summary(epic.id).status).toBe("review");
  });

  it("refuses to archive an epic with open tasks, but not one whose tasks are all done", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    expectCode(
      () => s.tasks.update(epic.id, { archived: true }, "user"),
      "VALIDATION",
      /still has open tasks \(#\d+\)/,
    );
    s.tasks.move(a.id, { status: "done" }, "user");
    expect(s.tasks.update(epic.id, { archived: true }, "user").archivedAt).not.toBeNull();
  });

  it("archives an epic with its Done tasks, and unarchiving it brings back only those", () => {
    const { s, events, epic, child } = setup();
    const a = child("A");
    const b = child("B");
    const early = child("Early");
    for (const t of [a, b, early]) s.tasks.move(t.id, { status: "done" }, "user");
    s.tasks.update(early.id, { archived: true }, "user");
    // The stamp is what ties a task to its epic, so the epic can't be archived in the same millisecond.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1000);
    const archivedAt = (id: string) => s.tasks.summary(id).archivedAt;

    events.length = 0;
    const archived = s.tasks.update(epic.id, { archived: true }, "user");
    expect(archived.status).toBe("done");
    const published = () => events.flatMap((e) => (e.type === "task.upserted" ? [e.task.id] : []));
    expect(published()).toEqual(expect.arrayContaining([epic.id, a.id, b.id]));
    // Same stamp as the epic, and the earlier one keeps its own.
    expect(archivedAt(a.id)).toBe(archived.archivedAt);
    expect(archivedAt(b.id)).toBe(archived.archivedAt);
    expect(archivedAt(early.id)).not.toBe(archived.archivedAt);
    expect(s.tasks.detail(a.id).events.at(-1)).toMatchObject({
      type: "archived",
      payload: { withEpic: epic.number },
    });
    expect(s.tasks.summary(a.id).parent?.id).toBe(epic.id);

    events.length = 0;
    const back = s.tasks.update(epic.id, { archived: false }, "user");
    expect(back.status).toBe("done");
    expect(published()).toEqual(expect.arrayContaining([epic.id, a.id, b.id]));
    expect(archivedAt(a.id)).toBeNull();
    expect(archivedAt(b.id)).toBeNull();
    expect(archivedAt(early.id)).not.toBeNull();
    expect(s.tasks.detail(a.id).events.at(-1)).toMatchObject({
      type: "unarchived",
      payload: { withEpic: epic.number },
    });
    expect(s.tasks.summary(epic.id).rollup).toMatchObject({ total: 2, done: 2 });
  });

  it("derives an unarchived epic from the tasks it comes back to", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    s.tasks.move(a.id, { status: "done" }, "user");
    s.tasks.update(epic.id, { archived: true }, "user");
    // Taken out while archived, so the epic comes back with nothing counted.
    s.tasks.update(a.id, { epicId: null }, "user");
    expect(s.tasks.update(epic.id, { archived: false }, "user").status).toBe("backlog");
  });

  it("doesn't re-derive an archived epic when a leftover task of it is archived", () => {
    const { s, db, epic, child } = setup();
    const a = child("A");
    s.tasks.move(a.id, { status: "done" }, "user");
    // What an epic archived before tasks went with it looks like: the task is unarchived, still pointing at the epic.
    db.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), epic.id);
    s.tasks.update(a.id, { archived: true }, "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "done", archivedAt: expect.any(String) });
  });

  it("unarchives an archived epic when a leftover Done task of it is reopened, and re-derives it", () => {
    const { s, db, epic, child } = setup();
    const [a, early] = [child("A"), child("Early")];
    for (const t of [a, early]) s.tasks.move(t.id, { status: "done" }, "user");
    s.tasks.update(early.id, { archived: true }, "user");
    db.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), epic.id);

    s.tasks.move(a.id, { status: "planned" }, "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "planned", archivedAt: null });
    expect(s.tasks.summary(early.id).archivedAt).not.toBeNull();
    expect(s.tasks.detail(epic.id).events.find((e) => e.type === "unarchived")).toMatchObject({
      payload: { becauseTask: a.number, reopened: true },
    });
  });

  it("unarchives an archived epic when a task archived with it is unarchived, leaving the others archived", async () => {
    const { s, events, epic, child, request } = setup();
    const [a, b] = [child("A"), child("B")];
    for (const t of [a, b]) s.tasks.move(t.id, { status: "done" }, "user");
    s.tasks.update(epic.id, { archived: true }, "user");

    events.length = 0;
    // Through REST, as the UI does it.
    const res = await request(`/api/tasks/${a.id}`, { method: "PATCH", json: { archived: false } });
    expect(res.status).toBe(200);
    // The board relies on this to show the epic again.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task.upserted",
        task: expect.objectContaining({ id: epic.id, archivedAt: null }),
      }),
    );
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "done", archivedAt: null });
    expect(s.tasks.summary(a.id).archivedAt).toBeNull();
    expect(s.tasks.summary(b.id).archivedAt).not.toBeNull();
    expect(s.tasks.summary(epic.id).rollup).toMatchObject({ total: 1, done: 1 });
    expect(s.tasks.detail(epic.id).events.find((e) => e.type === "unarchived")).toMatchObject({
      payload: { becauseTask: a.number, reopened: false },
    });
    // Reopening it afterwards moves the epic like any other.
    s.tasks.move(a.id, { status: "in_progress" }, "user");
    expect(s.tasks.summary(epic.id).status).toBe("in_progress");
  });

  it("leaves the epic unarchived, and empty in Backlog, when its only task is archived again", () => {
    const { s, epic, child } = setup();
    const a = child("A");
    s.tasks.move(a.id, { status: "done" }, "user");
    s.tasks.update(epic.id, { archived: true }, "user");
    s.tasks.update(a.id, { archived: false }, "user");
    s.tasks.update(a.id, { archived: true }, "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "backlog", archivedAt: null });
  });

  it("still refuses to create a task in, or move one into, an archived epic", () => {
    const { s, project, epic, child } = setup();
    const a = child("A");
    s.tasks.move(a.id, { status: "done" }, "user");
    s.tasks.update(epic.id, { archived: true }, "user");
    const loose = s.tasks.create({ projectId: project.id, title: "Loose", plan: plan("a") });
    expectCode(
      () => s.tasks.create({ projectId: project.id, title: "New", epicId: epic.id, plan: plan("a") }),
      "VALIDATION",
      /archived; unarchive it first/,
    );
    expectCode(
      () => s.tasks.update(loose.id, { epicId: epic.id }, "user"),
      "VALIDATION",
      /archived; unarchive it first/,
    );
    expect(s.tasks.summary(loose.id).parent).toBeNull();
  });

  it("republishes its tasks when an epic is renamed, so their cards show the new title", () => {
    const { s, events, epic, child } = setup();
    const a = child("A");
    events.length = 0;
    s.tasks.update(epic.id, { title: "Storefront Revamp v2" }, "user");
    const upserted = events.flatMap((e) => (e.type === "task.upserted" ? [e.task] : []));
    expect(upserted.find((t) => t.id === a.id)?.parent?.title).toBe("Storefront Revamp v2");
  });

  it("creates an epic with its tasks all or nothing", () => {
    const { s, project, other } = setup();
    const a = s.tasks.create({ projectId: project.id, title: "A", plan: plan("a") });
    const b = s.tasks.create({ projectId: other.id, title: "B", plan: plan("a") });
    expectCode(() => s.tasks.createEpic({ projectId: project.id, title: "Half" }, [a.id, b.id], "user"), "VALIDATION");
    expect(s.tasks.summaries().some((t) => t.title === "Half")).toBe(false);
    expect(s.tasks.summary(a.id).parent).toBeNull();
    const made = s.tasks.createEpic({ projectId: project.id, title: "Whole" }, [a.id], "user");
    expect(made.children.map((c) => c.id)).toEqual([a.id]);
  });

  it("publishes the epic's card when a child changes", () => {
    const { s, events, epic, child } = setup();
    const a = child("A");
    events.length = 0;
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    const upserted = events.flatMap((e) => (e.type === "task.upserted" ? [e.task.id] : []));
    expect(upserted).toEqual(expect.arrayContaining([a.id, epic.id]));
    events.length = 0;
    s.plans.addSteps(s.tasks.detail(a.id).phases[0]!.id, [{ title: "more" }], "agent");
    expect(events).toContainEqual({ type: "task.detail_changed", taskId: epic.id });
  });
});

describe("integration epics", () => {
  const snapshot = (state: "open" | "draft" | "merged", headRef: string | null) => ({
    state,
    title: "Epic",
    checks: "passing" as const,
    reviewDecision: null,
    mergeable: "mergeable" as const,
    headRef,
    updatedAt: null,
  });

  /** An epic delivered through its branch, with its tasks done. */
  function finished() {
    const ctx = setup();
    const branch = epicBranchName(ctx.s.tasks.summary(ctx.epic.id));
    ctx.s.tasks.setDelivery(ctx.epic.id, "integration", branch, "user");
    const [a, b] = [ctx.child("A"), ctx.child("B")];
    ctx.s.tasks.move(a.id, { status: "done" }, "agent");
    ctx.s.tasks.move(b.id, { status: "done" }, "agent");
    const pr = ctx.s.links.add(ctx.epic.id, { value: "https://github.com/acme/app/pull/9" }, "autopilot");
    return { ...ctx, branch, a, b, pr };
  }

  it("stays in Review when its tasks are done, until its branch merges", () => {
    const { s, epic, branch, pr } = finished();
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "review", integrationMerge: { merged: false } });
    s.links.setSnapshot(pr.id, snapshot("draft", branch));
    expect(s.tasks.summary(epic.id)).toMatchObject({
      status: "review",
      integrationMerge: { merged: false, pr: { number: 9 } },
    });
  });

  it("is Done once its PR from the branch merges, and logs which", () => {
    const { s, epic, branch, pr } = finished();
    s.links.setSnapshot(pr.id, snapshot("merged", branch));
    expect(s.tasks.summary(epic.id)).toMatchObject({
      status: "done",
      integrationMerge: { merged: true, by: "pr" },
    });
    const change = s.tasks.detail(epic.id).events.find((e) => e.type === "status_changed" && e.payload.to === "done");
    expect(change?.payload).toMatchObject({ fromChildren: true, mergedPr: "acme/app#9" });
  });

  it("ignores a merged PR that isn't from the branch", () => {
    const { s, epic, pr } = finished();
    s.links.setSnapshot(pr.id, snapshot("merged", "feature/other"));
    expect(s.tasks.summary(epic.id).status).toBe("review");
  });

  it("goes back to Review when its merged PR is unlinked, and Done again when a task finishes after the merge", () => {
    const { s, epic, branch, pr, a } = finished();
    s.links.setSnapshot(pr.id, snapshot("merged", branch));
    s.links.remove(pr.id, "user");
    expect(s.tasks.summary(epic.id).status).toBe("review");
    const again = s.links.add(epic.id, { value: "https://github.com/acme/app/pull/9" }, "user");
    s.links.setSnapshot(again.id, snapshot("merged", branch));
    expect(s.tasks.summary(epic.id).status).toBe("done");
    // A reopened task pulls the epic back; the merge stays on record, so finishing it again finishes the epic.
    s.tasks.move(a.id, { status: "in_progress" }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("in_progress");
    s.tasks.move(a.id, { status: "done" }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("done");
  });

  it("is Done when marked merged by moving it to Done", () => {
    const { s, epic } = finished();
    s.tasks.move(epic.id, { status: "done" }, "user");
    const done = s.tasks.summary(epic.id);
    expect(done).toMatchObject({ status: "done", integrationMerge: { merged: true, by: "manual" } });
    const detail = s.tasks.detail(epic.id);
    expect(detail.events.map((e) => e.type)).toContain("integration_marked_merged");
    expect(detail.events.find((e) => e.type === "status_changed" && e.payload.to === "done")?.payload).toMatchObject({
      markedMerged: true,
    });
  });

  it("refuses to mark it merged while tasks are open, with no tasks, or when it doesn't deliver through a branch", () => {
    expect.hasAssertions();
    const { s, epic, a, project } = finished();
    s.tasks.move(a.id, { status: "review" }, "agent");
    expectCode(() => s.tasks.move(epic.id, { status: "done" }, "user"), "VALIDATION", /still open: #\d+/);
    const empty = s.tasks.create({ projectId: project.id, title: "Empty", kind: "epic" });
    s.tasks.setDelivery(empty.id, "integration", "epic/9-empty", "user");
    expectCode(() => s.tasks.move(empty.id, { status: "done" }, "user"), "VALIDATION", /none yet/);
    const plain = s.tasks.create({ projectId: project.id, title: "Plain", kind: "epic" });
    expectCode(() => s.tasks.move(plain.id, { status: "done" }, "user"), "VALIDATION", /follows its child/);
    s.tasks.setDelivery(plain.id, "main", null, "user");
    expectCode(() => s.tasks.move(plain.id, { status: "done" }, "user"), "VALIDATION", /follows its child/);
  });

  it("finishes on its tasks alone when it delivers to main, or no delivery was chosen", () => {
    const { s, project } = setup();
    const epic = s.tasks.create({ projectId: project.id, title: "Main", kind: "epic" });
    const task = s.tasks.create({ projectId: project.id, title: "T", epicId: epic.id, plan: plan("a") });
    s.tasks.setDelivery(epic.id, "main", null, "user");
    s.tasks.move(task.id, { status: "done" }, "agent");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "done", integrationMerge: null });
  });

  it("clears a merge marked by hand when the delivery changes, and re-derives the epic", () => {
    const { s, epic, branch } = finished();
    s.tasks.move(epic.id, { status: "done" }, "user");
    // Same branch again is a no-op, so the mark stays.
    s.tasks.setDelivery(epic.id, "integration", branch, "user");
    expect(s.tasks.summary(epic.id).status).toBe("done");
    s.tasks.setDelivery(epic.id, "integration", "epic/99-elsewhere", "user");
    expect(s.tasks.summary(epic.id)).toMatchObject({ status: "review", integrationMerge: { merged: false } });
  });

  it("makes an epic that already had everything done wait once it switches to integration", () => {
    const { s, project } = setup();
    const epic = s.tasks.create({ projectId: project.id, title: "Late", kind: "epic" });
    const task = s.tasks.create({ projectId: project.id, title: "T", epicId: epic.id, plan: plan("a") });
    s.tasks.move(task.id, { status: "done" }, "agent");
    expect(s.tasks.summary(epic.id).status).toBe("done");
    s.tasks.setDelivery(epic.id, "integration", "epic/5-late", "user");
    expect(s.tasks.summary(epic.id).status).toBe("review");
  });
});
