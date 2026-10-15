import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

function setup() {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "P" });
  const task = s.tasks.create({
    projectId: project.id,
    title: "T",
    plan: { phases: [{ title: "One", steps: [{ title: "a" }, { title: "b" }] }] },
  });
  return { ...h, s, task };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : "NOT_APP_ERROR";
  }
  return undefined;
};

describe("plans", () => {
  it("rejects plans that would leave a task outside Backlog without steps", () => {
    const { s, task } = setup();
    expect(codeOf(() => s.plans.setPlan(task.id, { phases: [{ title: "Empty", steps: [] }] }, "user"))).toBe(
      "PLAN_REQUIRED",
    );
    const [a, b] = task.phases[0]!.steps;
    s.plans.deleteStep(a!.id, "user");
    expect(codeOf(() => s.plans.deleteStep(b!.id, "user"))).toBe("PLAN_REQUIRED");
    expect(codeOf(() => s.plans.deletePhase(task.phases[0]!.id, "user"))).toBe("PLAN_REQUIRED");

    s.tasks.move(task.id, { status: "backlog" }, "user");
    s.plans.deleteStep(b!.id, "user");
    expect(s.tasks.summary(task.id).progress.total).toBe(0);
  });

  it("setPlan keeps matched steps' status and deletes missing ones", () => {
    const { s, task } = setup();
    const [a, b] = task.phases[0]!.steps;
    s.plans.updateStep(a!.id, { status: "done" }, "agent");
    const before = s.tasks.detail(task.id).phases[0]!.steps[0]!;

    const detail = s.plans.setPlan(
      task.id,
      {
        context: "approach",
        phases: [
          { title: "New phase", steps: [{ title: "fresh" }] },
          { id: task.phases[0]!.id, title: "One renamed", steps: [{ id: a!.id, title: "a renamed" }] },
        ],
      },
      "agent",
    );
    expect(detail.planContext).toBe("approach");
    expect(detail.phases.map((p) => p.title)).toEqual(["New phase", "One renamed"]);
    const kept = detail.phases[1]!.steps[0]!;
    expect(kept).toMatchObject({ id: a!.id, title: "a renamed", status: "done", completedAt: before.completedAt });
    expect(detail.phases.flatMap((p) => p.steps).some((st) => st.id === b!.id)).toBe(false);
    expect(detail.phases[1]!.id).toBe(task.phases[0]!.id);
  });

  it("sets and clears step timestamps", () => {
    const { s, task } = setup();
    const id = task.phases[0]!.steps[0]!.id;
    const started = s.plans.updateStep(id, { status: "in_progress" }, "agent");
    expect(started.startedAt).not.toBeNull();
    expect(started.completedAt).toBeNull();
    const done = s.plans.updateStep(id, { status: "done" }, "agent");
    expect(done.completedAt).not.toBeNull();
    expect(done.startedAt).toBe(started.startedAt);
    const reopened = s.plans.updateStep(id, { status: "in_progress" }, "agent");
    expect(reopened.completedAt).toBeNull();
    expect(reopened.startedAt).toBe(started.startedAt);
    const reset = s.plans.updateStep(id, { status: "todo" }, "agent");
    expect(reset.startedAt).toBeNull();
    expect(s.tasks.detail(task.id).events.at(-1)).toMatchObject({
      type: "step_updated",
      payload: { stepId: id, from: "in_progress", to: "todo" },
    });
  });

  it("appends notes, adds and moves steps, and resolves phase.step labels", () => {
    const { s, task } = setup();
    const phase = task.phases[0]!;
    const [a, b] = phase.steps;
    s.plans.updateStep(a!.id, { notes: "one" }, "agent");
    expect(s.plans.updateStep(a!.id, { appendNotes: "two" }, "agent").notes).toBe("one\n\ntwo");

    const [x] = s.plans.addSteps(phase.id, [{ title: "x" }], "agent", { afterStepId: a!.id });
    const titles = () => s.tasks.detail(task.id).phases[0]!.steps.map((st) => st.title);
    expect(titles()).toEqual(["a", "x", "b"]);
    s.plans.moveStep(b!.id, { beforeId: a!.id }, "agent");
    expect(titles()).toEqual(["b", "a", "x"]);

    const second = s.plans.addPhase(task.id, "Two", "agent");
    s.plans.moveStep(x!.id, { phaseId: second.id }, "agent");
    expect(s.plans.resolveStepId(task.id, "2.1")).toBe(x!.id);
    expect(s.tasks.summary(task.id).currentStep?.index).toBe("1.1");
    expect(codeOf(() => s.plans.resolveStepId(task.id, "9.9"))).toBe("NOT_FOUND");
  });
});
