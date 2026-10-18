import type { PlanInput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const plan = (...titles: string[]): PlanInput => ({
  phases: [{ title: "Build", steps: titles.map((title) => ({ title })) }],
});

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  return { ...h, s: h.services, project };
}

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("tasks", () => {
  it("lands in backlog without a plan and planned with one, numbering globally", () => {
    const { s, project } = setup();
    const backlog = s.tasks.create({ projectId: project.id, title: "Backlog" });
    const planned = s.tasks.create({ projectId: project.id, title: "Planned", plan: plan("a", "b") });
    expect(backlog.status).toBe("backlog");
    expect(planned.status).toBe("planned");
    expect(planned.number).toBe(backlog.number + 1);
    expect(s.tasks.resolveId(`#${planned.number}`)).toBe(planned.id);
    expect(s.tasks.resolveId(String(backlog.number))).toBe(backlog.id);
    expect(planned.events.map((e) => e.type)).toEqual(["created", "plan_set"]);
  });

  it("gates leaving backlog on having plan steps", () => {
    const { s, project } = setup();
    const backlog = s.tasks.create({ projectId: project.id, title: "Backlog" });
    expectCode(() => s.tasks.move(backlog.id, { status: "in_progress" }, "user"), "PLAN_REQUIRED");
    s.plans.setPlan(backlog.id, plan("first"), "agent");
    const moved = s.tasks.move(backlog.id, { status: "in_progress" }, "agent");
    expect(moved.status).toBe("in_progress");
    const detail = s.tasks.detail(backlog.id);
    expect(detail.events.at(-1)).toMatchObject({
      type: "status_changed",
      actor: "agent",
      payload: { from: "backlog", to: "in_progress" },
    });
  });

  it("adds a move's reason to the status event without letting it override the move", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "T", plan: plan("a") });
    s.tasks.move(task.id, { status: "review" }, "github", { mergedPr: "acme/app#1", from: "x", to: "y" });
    expect(s.tasks.detail(task.id).events.at(-1)?.payload).toEqual({
      mergedPr: "acme/app#1",
      from: "planned",
      to: "review",
    });
  });

  it("derives progress, step statuses and current step in summaries", () => {
    const { s, project } = setup();
    const task = s.tasks.create({
      projectId: project.id,
      title: "T",
      plan: {
        phases: [
          {
            title: "One",
            steps: [
              { title: "a", status: "done" },
              { title: "b", status: "skipped" },
            ],
          },
          { title: "Two", steps: [{ title: "c" }, { title: "d", status: "blocked" }] },
        ],
      },
    });
    const summary = s.tasks.summary(task.id);
    expect(summary.progress).toEqual({ done: 2, total: 4 });
    expect(summary.stepStatuses).toEqual(["done", "skipped", "todo", "blocked"]);
    expect(summary.currentStep).toMatchObject({ title: "d", index: "2.2", phaseTitle: "Two" });
    expect(summary.attention.map((a) => a.kind)).toEqual(["blocked_step"]);
  });

  it("reorders within a column and appends to the end on status change", () => {
    const { s, project } = setup();
    const ids = ["a", "b", "c"].map((title) => s.tasks.create({ projectId: project.id, title, plan: plan("x") }).id);
    const [a, b, c] = ids as [string, string, string];
    const column = () => s.tasks.summaries({ projectId: project.id, status: "planned" }).map((t) => t.title);
    expect(column()).toEqual(["a", "b", "c"]);

    s.tasks.move(c, { beforeId: a }, "user");
    expect(column()).toEqual(["c", "a", "b"]);
    s.tasks.move(c, { afterId: a }, "user");
    expect(column()).toEqual(["a", "c", "b"]);

    const target = s.tasks.create({ projectId: project.id, title: "existing", plan: plan("x") });
    s.tasks.move(target.id, { status: "review" }, "user");
    s.tasks.move(b, { status: "review" }, "user");
    expect(s.tasks.summaries({ projectId: project.id, status: "review" }).map((t) => t.title)).toEqual([
      "existing",
      "b",
    ]);

    s.tasks.move(a, { status: "review", beforeId: target.id }, "user");
    expect(s.tasks.summaries({ projectId: project.id, status: "review" }).map((t) => t.title)).toEqual([
      "a",
      "existing",
      "b",
    ]);
    expectCode(() => s.tasks.move(c, { beforeId: "nope" }, "user"), "VALIDATION");
  });

  it("matches queries on title, description, #number and Jira keys", () => {
    const { s, project } = setup();
    const one = s.tasks.create({ projectId: project.id, title: "Fix login", description: "OAuth callback" });
    const two = s.tasks.create({ projectId: project.id, title: "Other", links: [{ value: "PAY-77" }] });
    const titles = (query: string) => s.tasks.summaries({ query }).map((t) => t.title);
    expect(titles("LOGIN")).toEqual(["Fix login"]);
    expect(titles("oauth")).toEqual(["Fix login"]);
    expect(titles(`#${two.number}`)).toEqual(["Other"]);
    expect(titles("pay-77")).toEqual(["Other"]);
    expect(one.id).toBeTruthy();
  });

  it("links Jira keys in the title on create and rename, but not keys only in the description", () => {
    const { s, project } = setup();
    const jiraKeys = (id: string) => s.tasks.detail(id).links.flatMap((l) => (l.kind === "jira" ? [l.ref.key] : []));
    const backlog = s.tasks.create({ projectId: project.id, title: "CORE-1245 Fix login", actor: "agent" });
    const planned = s.tasks.create({
      projectId: project.id,
      title: "Fix PAY-7 (UTF-8)",
      description: "See OPS-9",
      plan: plan("a"),
      links: [{ value: "PAY-7" }],
    });
    expect(jiraKeys(backlog.id)).toEqual(["CORE-1245"]);
    expect(backlog.events.find((e) => e.type === "link_added")).toMatchObject({ actor: "agent" });
    expect(jiraKeys(planned.id)).toEqual(["PAY-7"]);

    s.tasks.update(backlog.id, { title: "CORE-1245 and CORE-1246 Fix login" }, "agent");
    s.tasks.update(backlog.id, { title: "CORE-1245 and CORE-1246: fix login" }, "agent");
    expect(jiraKeys(backlog.id)).toEqual(["CORE-1245", "CORE-1246"]);
    expect(s.tasks.detail(backlog.id).events.filter((e) => e.type === "link_added")).toHaveLength(2);
  });

  it("archives via update and records lastNote", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "T" });
    s.tasks.addNote(task.id, "first", "agent");
    s.tasks.addNote(task.id, "handover: tests next", "agent");
    expect(s.tasks.summary(task.id).lastNote).toMatchObject({ text: "handover: tests next", actor: "agent" });
    s.tasks.update(task.id, { archived: true }, "user");
    expect(s.board.snapshot().tasks).toHaveLength(0);
    expect(s.tasks.summaries({ includeArchived: true })).toHaveLength(1);
  });
});

describe("events", () => {
  it("publishes after commit and not at all when the transaction throws", () => {
    const { s, project, events, bus } = setup();
    events.length = 0;
    let seenInsideTx = -1;
    const unsubscribe = bus.subscribe(() => {
      // When a listener runs, the write must already be visible (committed).
      seenInsideTx = s.tasks.summaries({ projectId: project.id }).length;
    });
    s.tasks.create({ projectId: project.id, title: "T", plan: plan("a") });
    unsubscribe();
    expect(seenInsideTx).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["task.upserted", "task.detail_changed"]);

    events.length = 0;
    expect(() => s.tasks.create({ projectId: project.id, title: "Bad", links: [{ value: "not a link" }] })).toThrow(
      "Not a recognisable link",
    );
    expect(events).toEqual([]);
    expect(s.tasks.summaries({ projectId: project.id })).toHaveLength(1);
  });

  it("cascades project delete with task.deleted events", () => {
    const { s, project, events } = setup();
    const t1 = s.tasks.create({ projectId: project.id, title: "1" });
    const t2 = s.tasks.create({ projectId: project.id, title: "2" });
    events.length = 0;
    s.projects.delete(project.id);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "task.deleted", taskId: t1.id },
        { type: "task.deleted", taskId: t2.id },
        { type: "project.deleted", projectId: project.id },
      ]),
    );
    expect(events).toHaveLength(3);
    expectCode(() => s.tasks.summary(t1.id), "NOT_FOUND");
  });

  describe("delete", () => {
    it("only deletes archived tasks", () => {
      const { s, project, events } = setup();
      const task = s.tasks.create({ projectId: project.id, title: "Keep" });
      events.length = 0;
      expectCode(() => s.tasks.delete(task.id, "user"), "VALIDATION");
      expect(events).toEqual([]);
      expect(s.tasks.summary(task.id).title).toBe("Keep");
    });

    it("cascades the plan, links and activity and publishes task.deleted", () => {
      const { s, project, events, db } = setup();
      const task = s.tasks.create({
        projectId: project.id,
        title: "Gone",
        plan: plan("a", "b"),
        links: [{ value: "https://example.com" }],
      });
      s.tasks.addNote(task.id, "note", "user");
      s.tasks.update(task.id, { archived: true }, "user");
      events.length = 0;
      s.tasks.delete(task.id, "user");
      expect(events).toEqual([{ type: "task.deleted", taskId: task.id }]);
      expectCode(() => s.tasks.summary(task.id), "NOT_FOUND");
      for (const table of ["plan_phases", "plan_steps", "task_links", "task_events"]) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).get(task.id) as { n: number };
        expect({ table, n: row.n }).toEqual({ table, n: 0 });
      }
    });

    it("never reuses a deleted task's number, including after a project delete", () => {
      const { s, project } = setup();
      const first = s.tasks.create({ projectId: project.id, title: "One" });
      const second = s.tasks.create({ projectId: project.id, title: "Two" });
      expect([first.number, second.number]).toEqual([1, 2]);
      s.tasks.update(second.id, { archived: true }, "user");
      s.tasks.delete(second.id, "user");
      expect(s.tasks.create({ projectId: project.id, title: "Three" }).number).toBe(3);

      const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
      s.tasks.create({ projectId: other.id, title: "Four" });
      s.projects.delete(other.id);
      expect(s.tasks.create({ projectId: project.id, title: "Five" }).number).toBe(5);
    });

    it("keeps the resolution of tasks closed against it and logs why the link went", () => {
      const { s, project, events } = setup();
      const resolver = s.tasks.create({ projectId: project.id, title: "Resolver" });
      const dupe = s.tasks.create({ projectId: project.id, title: "Dupe" });
      s.tasks.close(dupe.id, { resolution: "duplicate", byTaskId: resolver.id }, "user");
      s.tasks.update(resolver.id, { archived: true }, "user");
      events.length = 0;
      s.tasks.delete(resolver.id, "agent");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.upserted",
          task: expect.objectContaining({ id: dupe.id, resolution: "duplicate", resolvedBy: null }),
        }),
      );
      expect(s.tasks.detail(dupe.id).events.at(-1)).toMatchObject({
        type: "resolver_deleted",
        actor: "agent",
        payload: { number: resolver.number, title: "Resolver" },
      });
    });

    it("drops a deleted closed task from its resolver's list", () => {
      const { s, project, events } = setup();
      const resolver = s.tasks.create({ projectId: project.id, title: "Resolver" });
      const dupe = s.tasks.create({ projectId: project.id, title: "Dupe" });
      s.tasks.close(dupe.id, { resolution: "duplicate", byTaskId: resolver.id }, "user");
      s.tasks.update(dupe.id, { archived: true }, "user");
      events.length = 0;
      s.tasks.delete(dupe.id, "user");
      expect(events).toContainEqual({ type: "task.detail_changed", taskId: resolver.id });
      expect(s.tasks.detail(resolver.id).resolves).toEqual([]);
    });
  });

  describe("close", () => {
    it("re-closing against another task refreshes the previous one, and rejects closing two tasks against each other", () => {
      const { s, project, events } = setup();
      const a = s.tasks.create({ projectId: project.id, title: "A" });
      const b = s.tasks.create({ projectId: project.id, title: "B" });
      const c = s.tasks.create({ projectId: project.id, title: "C" });
      s.tasks.close(a.id, { resolution: "duplicate", byTaskId: b.id }, "user");
      expectCode(() => s.tasks.close(b.id, { resolution: "duplicate", byTaskId: a.id }, "user"), "VALIDATION");

      events.length = 0;
      s.tasks.close(a.id, { resolution: "completed", byTaskId: c.id }, "user");
      expect(events).toContainEqual({ type: "task.detail_changed", taskId: b.id });
      expect(events).toContainEqual({ type: "task.detail_changed", taskId: c.id });
      expect(s.tasks.detail(b.id).resolves).toEqual([]);
      expect(s.tasks.detail(c.id).resolves.map((r) => r.id)).toEqual([a.id]);
    });

    it("closes an archived task without unarchiving it", () => {
      const { s, project } = setup();
      const task = s.tasks.create({ projectId: project.id, title: "Old" });
      s.tasks.update(task.id, { archived: true }, "user");
      const closed = s.tasks.close(task.id, { resolution: "wont_do" }, "user");
      expect(closed.status).toBe("done");
      expect(closed.archivedAt).not.toBeNull();
    });

    it("refreshes the resolver's detail when a closed task is renamed", () => {
      const { s, project, events } = setup();
      const original = s.tasks.create({ projectId: project.id, title: "Original" });
      const dupe = s.tasks.create({ projectId: project.id, title: "Dupe" });
      s.tasks.close(dupe.id, { resolution: "duplicate", byTaskId: original.id }, "user");
      events.length = 0;
      s.tasks.update(dupe.id, { title: "Dupe renamed" }, "user");
      expect(events).toContainEqual({ type: "task.detail_changed", taskId: original.id });
    });

    it("refreshes cards in other projects when their resolver's project is deleted", () => {
      const { s, project, events } = setup();
      const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
      const original = s.tasks.create({ projectId: other.id, title: "Original" });
      const dupe = s.tasks.create({ projectId: project.id, title: "Dupe" });
      s.tasks.close(dupe.id, { resolution: "duplicate", byTaskId: original.id }, "user");
      events.length = 0;
      s.projects.delete(other.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.upserted",
          task: expect.objectContaining({ id: dupe.id, resolution: "duplicate", resolvedBy: null }),
        }),
      );

      // The other direction: deleting the closed task's project refreshes its resolver's detail.
      const keeper = s.tasks.create({ projectId: project.id, title: "Keeper" });
      const gone = s.projects.create({ title: "Gamma", workspaceRoot: "/work/gamma" });
      const closed = s.tasks.create({ projectId: gone.id, title: "Closed" });
      s.tasks.close(closed.id, { resolution: "completed", byTaskId: keeper.id }, "user");
      events.length = 0;
      s.projects.delete(gone.id);
      expect(events).toContainEqual({ type: "task.detail_changed", taskId: keeper.id });
    });

    it("moves a planless task to Done only through close, linking the delivering task", () => {
      const { s, project, events } = setup();
      const shipped = s.tasks.create({ projectId: project.id, title: "Shipped", plan: plan("a") });
      const backlog = s.tasks.create({ projectId: project.id, title: "Same thing" });
      expectCode(() => s.tasks.move(backlog.id, { status: "done" }, "user"), "PLAN_REQUIRED");

      events.length = 0;
      const closed = s.tasks.close(backlog.id, { resolution: "completed", byTaskId: shipped.id }, "agent");
      expect(closed).toMatchObject({
        status: "done",
        resolution: "completed",
        resolvedBy: { id: shipped.id, number: shipped.number, title: "Shipped" },
      });
      expect(closed.events.at(-1)).toMatchObject({
        type: "closed",
        actor: "agent",
        payload: { resolution: "completed", from: "backlog", byTask: shipped.number },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "task.upserted", task: expect.objectContaining({ id: backlog.id }) }),
          { type: "task.detail_changed", taskId: shipped.id },
        ]),
      );
      expect(s.tasks.detail(shipped.id).resolves).toEqual([
        { id: backlog.id, number: backlog.number, title: "Same thing", resolution: "completed" },
      ]);
    });

    it("rejects a missing, unknown or self by-task, and a by-task on won't do", () => {
      const { s, project } = setup();
      const a = s.tasks.create({ projectId: project.id, title: "A" });
      const b = s.tasks.create({ projectId: project.id, title: "B" });
      expectCode(() => s.tasks.close(a.id, { resolution: "duplicate" }, "user"), "VALIDATION");
      expectCode(() => s.tasks.close(a.id, { resolution: "duplicate", byTaskId: "nope" }, "user"), "NOT_FOUND");
      expectCode(() => s.tasks.close(a.id, { resolution: "completed", byTaskId: a.id }, "user"), "VALIDATION");
      expectCode(() => s.tasks.close(a.id, { resolution: "wont_do", byTaskId: b.id }, "user"), "VALIDATION");
      expect(s.tasks.summary(a.id)).toMatchObject({ status: "backlog", resolution: null });

      const wontDo = s.tasks.close(a.id, { resolution: "wont_do" }, "user");
      expect(wontDo).toMatchObject({ status: "done", resolution: "wont_do", resolvedBy: null });
    });

    it("clears the resolution when the task leaves Done", () => {
      const { s, project, events } = setup();
      const original = s.tasks.create({ projectId: project.id, title: "Original" });
      const dupe = s.tasks.create({ projectId: project.id, title: "Dupe" });
      s.tasks.close(dupe.id, { resolution: "duplicate", byTaskId: original.id }, "user");

      events.length = 0;
      const reopened = s.tasks.move(dupe.id, { status: "backlog" }, "user");
      expect(reopened).toMatchObject({ status: "backlog", resolution: null, resolvedBy: null });
      expect(s.tasks.detail(dupe.id).events.at(-1)).toMatchObject({
        type: "status_changed",
        payload: { from: "done", to: "backlog", clearedResolution: "duplicate" },
      });
      expect(events).toContainEqual({ type: "task.detail_changed", taskId: original.id });
      expect(s.tasks.detail(original.id).resolves).toEqual([]);
    });

    it("refreshes resolved cards when the delivering task is renamed", () => {
      const { s, project, events } = setup();
      const original = s.tasks.create({ projectId: project.id, title: "Original" });
      const dupe = s.tasks.create({ projectId: project.id, title: "Dupe" });
      s.tasks.close(dupe.id, { resolution: "duplicate", byTaskId: original.id }, "user");
      events.length = 0;
      s.tasks.update(original.id, { title: "Renamed" }, "user");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.upserted",
          task: expect.objectContaining({ id: dupe.id, resolvedBy: expect.objectContaining({ title: "Renamed" }) }),
        }),
      );
    });
  });
});

describe("priority", () => {
  it("starts off, is set on create, and logs a change once", () => {
    const { s, project } = setup();
    const plain = s.tasks.create({ projectId: project.id, title: "Plain" });
    expect(plain.priority).toBe(false);
    expect(s.tasks.create({ projectId: project.id, title: "Urgent", priority: true }).priority).toBe(true);

    expect(s.tasks.update(plain.id, { priority: true }, "user").priority).toBe(true);
    const again = s.tasks.update(plain.id, { priority: true }, "user");
    expect(again.events.filter((e) => e.type === "updated").map((e) => e.payload)).toEqual([{ fields: ["priority"] }]);
    expect(s.tasks.update(plain.id, { priority: false }, "user").priority).toBe(false);
  });

  it("is refused on epics, which have no card in the lane", () => {
    const { s, project } = setup();
    expectCode(() => s.tasks.create({ projectId: project.id, title: "E", kind: "epic", priority: true }), "VALIDATION");
    const epic = s.tasks.create({ projectId: project.id, title: "E", kind: "epic" });
    expectCode(() => s.tasks.update(epic.id, { priority: true }, "user"), "VALIDATION");
    expect(s.tasks.update(epic.id, { priority: false }, "user").priority).toBe(false);
  });
});

describe("auto-merge flag", () => {
  it("starts as Default, is set on create, and logs a change once", () => {
    const { s, project } = setup();
    const plain = s.tasks.create({ projectId: project.id, title: "Plain" });
    expect(plain.autoMerge).toBeNull();
    expect(s.tasks.create({ projectId: project.id, title: "On", autoMerge: true }).autoMerge).toBe(true);

    expect(s.tasks.update(plain.id, { autoMerge: true }, "user").autoMerge).toBe(true);
    const again = s.tasks.update(plain.id, { autoMerge: true }, "user");
    expect(again.events.filter((e) => e.type === "updated").map((e) => e.payload)).toEqual([{ fields: ["autoMerge"] }]);
    expect(s.tasks.update(plain.id, { autoMerge: false }, "user").autoMerge).toBe(false);
    expect(s.tasks.update(plain.id, { autoMerge: null }, "user").autoMerge).toBeNull();
  });

  it("is refused on epics, which have no PR of their own to merge", () => {
    const { s, project } = setup();
    expectCode(
      () => s.tasks.create({ projectId: project.id, title: "E", kind: "epic", autoMerge: true }),
      "VALIDATION",
    );
    const epic = s.tasks.create({ projectId: project.id, title: "E", kind: "epic" });
    expectCode(() => s.tasks.update(epic.id, { autoMerge: false }, "user"), "VALIDATION");
    expect(s.tasks.update(epic.id, { autoMerge: null }, "user").autoMerge).toBeNull();
  });
});

describe("autopilot flag", () => {
  it("starts as Default, is set on create, and logs a change once", () => {
    const { s, project } = setup();
    const plain = s.tasks.create({ projectId: project.id, title: "Plain" });
    expect(plain.autopilot).toBeNull();
    const flagged = s.tasks.create({ projectId: project.id, title: "Flagged", autopilot: true });
    expect(flagged.autopilot).toBe(true);

    const off = s.tasks.update(plain.id, { autopilot: false }, "user");
    expect(off.autopilot).toBe(false);
    const again = s.tasks.update(plain.id, { autopilot: false }, "user");
    const updates = again.events.filter((e) => e.type === "updated");
    expect(updates.map((e) => e.payload)).toEqual([{ fields: ["autopilot"] }]);

    expect(s.tasks.update(plain.id, { autopilot: null }, "user").autopilot).toBeNull();
    expect(s.tasks.summaries().find((t) => t.id === flagged.id)?.autopilot).toBe(true);
  });

  it("is refused on epics, which Autopilot never starts", () => {
    const { s, project } = setup();
    expectCode(
      () => s.tasks.create({ projectId: project.id, title: "E", kind: "epic", autopilot: true }),
      "VALIDATION",
    );
    const epic = s.tasks.create({ projectId: project.id, title: "E", kind: "epic" });
    expectCode(() => s.tasks.update(epic.id, { autopilot: false }, "user"), "VALIDATION");
    expect(s.tasks.update(epic.id, { autopilot: null }, "user").autopilot).toBeNull();
  });
});

describe("suggested model", () => {
  it("is set by set_plan and create, kept when omitted, and cleared with null", () => {
    const { s, project } = setup();
    const created = s.tasks.create({
      projectId: project.id,
      title: "T",
      plan: { ...plan("a"), suggestedModel: { tier: "light", reason: "  " } },
    });
    expect(created.suggestedModel).toEqual({ tier: "light", reason: null });

    s.plans.setPlan(created.id, { ...plan("a", "b"), suggestedModel: { tier: "deep", reason: "Migration" } }, "agent");
    expect(s.tasks.detail(created.id).suggestedModel).toEqual({ tier: "deep", reason: "Migration" });

    s.plans.setPlan(created.id, plan("a"), "agent");
    expect(s.tasks.detail(created.id).suggestedModel).toEqual({ tier: "deep", reason: "Migration" });

    const cleared = s.tasks.update(created.id, { suggestedModel: null }, "user");
    expect(cleared.suggestedModel).toBeNull();
    expect(cleared.events.filter((e) => e.type === "suggested_model_changed").map((e) => e.payload)).toEqual([
      { tier: "light", reason: null },
      { tier: "deep", reason: "Migration" },
      { tier: null, reason: null },
    ]);
  });

  it("logs nothing when the suggestion is unchanged", () => {
    const { s, project } = setup();
    const task = s.tasks.create({ projectId: project.id, title: "T" });
    s.tasks.update(task.id, { suggestedModel: { tier: "standard" } }, "user");
    const again = s.tasks.update(task.id, { suggestedModel: { tier: "standard", reason: "" } }, "user");
    expect(again.events.filter((e) => e.type === "suggested_model_changed")).toHaveLength(1);
    expect(s.tasks.summary(task.id).suggestedModel).toEqual({ tier: "standard", reason: null });
  });

  it("round-trips the model tier settings, storing blank descriptions as none", () => {
    const { s } = setup();
    const t3 = { selection: { instanceId: "claude", model: "sonnet", options: [] }, label: "Claude Sonnet" };
    const updated = s.settings.update({
      modelTiers: {
        light: { description: "  ", t3 },
        standard: { description: "Sonnet, medium effort", t3: null },
        deep: { description: null, t3: null },
      },
    });
    expect(updated.modelTiers.light).toEqual({ description: null, t3 });
    expect(s.settings.get().modelTiers.standard.description).toBe("Sonnet, medium effort");
    // A partial update leaves the other tiers alone.
    const partial = s.settings.update({ modelTiers: { deep: { description: "Opus", t3: null } } });
    expect(partial.modelTiers).toMatchObject({ light: { t3 }, standard: { description: "Sonnet, medium effort" } });
    expect(partial.modelTiers.deep.description).toBe("Opus");
  });
});
