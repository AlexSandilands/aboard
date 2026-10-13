import type { PlanInput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const plan = (...titles: string[]): PlanInput => ({ phases: [{ title: "Build", steps: titles.map((title) => ({ title })) }] });

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
  it("lands in idea without a plan and planned with one, numbering globally", () => {
    const { s, project } = setup();
    const idea = s.tasks.create({ projectId: project.id, title: "Idea" });
    const planned = s.tasks.create({ projectId: project.id, title: "Planned", plan: plan("a", "b") });
    expect(idea.status).toBe("idea");
    expect(planned.status).toBe("planned");
    expect(planned.number).toBe(idea.number + 1);
    expect(s.tasks.resolveId(`#${planned.number}`)).toBe(planned.id);
    expect(s.tasks.resolveId(String(idea.number))).toBe(idea.id);
    expect(planned.events.map((e) => e.type)).toEqual(["created", "plan_set"]);
  });

  it("gates leaving idea on having plan steps", () => {
    const { s, project } = setup();
    const idea = s.tasks.create({ projectId: project.id, title: "Idea" });
    expectCode(() => s.tasks.move(idea.id, { status: "in_progress" }, "user"), "PLAN_REQUIRED");
    s.plans.setPlan(idea.id, plan("first"), "agent");
    const moved = s.tasks.move(idea.id, { status: "in_progress" }, "agent");
    expect(moved.status).toBe("in_progress");
    const detail = s.tasks.detail(idea.id);
    expect(detail.events.at(-1)).toMatchObject({ type: "status_changed", actor: "agent", payload: { from: "idea", to: "in_progress" } });
  });

  it("derives progress, step statuses and current step in summaries", () => {
    const { s, project } = setup();
    const task = s.tasks.create({
      projectId: project.id,
      title: "T",
      plan: {
        phases: [
          { title: "One", steps: [{ title: "a", status: "done" }, { title: "b", status: "skipped" }] },
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
    expect(s.tasks.summaries({ projectId: project.id, status: "review" }).map((t) => t.title)).toEqual(["existing", "b"]);

    s.tasks.move(a, { status: "review", beforeId: target.id }, "user");
    expect(s.tasks.summaries({ projectId: project.id, status: "review" }).map((t) => t.title)).toEqual(["a", "existing", "b"]);
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
    expect(() => s.tasks.create({ projectId: project.id, title: "Bad", links: [{ value: "not a link" }] })).toThrow();
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
});
