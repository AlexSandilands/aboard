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

  it("setPlan with protectStarted refuses to delete steps with progress or notes", () => {
    const { s, task } = setup();
    const [a] = task.phases[0]!.steps;
    const phaseId = task.phases[0]!.id;
    const keepA = { phases: [{ id: phaseId, title: "One", steps: [{ id: a!.id, title: "a" }] }] };

    // b is untouched (todo, no notes), so dropping it is fine.
    expect(s.plans.deletionsOf(task.id, keepA)).toEqual([
      { label: "1.2", title: "b", status: "todo", hasNotes: false, phaseDropped: false },
    ]);
    s.plans.setPlan(task.id, keepA, "agent", { protectStarted: true });
    expect(s.tasks.detail(task.id).events.at(-1)).toMatchObject({
      type: "plan_set",
      payload: { steps: 1, deleted: ["1.2 b"] },
    });

    // Once a is done, leaving it out is refused and nothing changes.
    s.plans.updateStep(a!.id, { status: "done" }, "agent");
    const replaceAll = { phases: [{ title: "Other", steps: [{ title: "x" }] }] };
    expect(codeOf(() => s.plans.setPlan(task.id, replaceAll, "agent", { protectStarted: true }))).toBe("CONFLICT");
    expect(s.tasks.detail(task.id).phases.map((p) => p.title)).toEqual(["One"]);

    // Without the option (REST, create_task) the replace goes through.
    s.plans.setPlan(task.id, replaceAll, "user");
    expect(s.tasks.detail(task.id).phases.map((p) => p.title)).toEqual(["Other"]);
  });

  it("setPlan with protectStarted refuses a partial update that drops whole phases of untouched steps", () => {
    const { s, task } = setup();
    const second = s.plans.addPhase(task.id, "Two", "agent");
    s.plans.addSteps(second.id, [{ title: "c" }], "agent");
    const [a, b] = s.tasks.detail(task.id).phases[0]!.steps;
    const onlyPhaseOne = {
      phases: [
        {
          id: task.phases[0]!.id,
          title: "One",
          steps: [
            { id: a!.id, title: "a" },
            { id: b!.id, title: "b" },
          ],
        },
      ],
    };
    const refused = () => s.plans.setPlan(task.id, onlyPhaseOne, "agent", { protectStarted: true });
    expect(codeOf(refused)).toBe("CONFLICT");
    expect(s.tasks.detail(task.id).phases.map((p) => p.title)).toEqual(["One", "Two"]);

    // Replacing everything with new steps (keeping none) is a rewrite, not a partial update.
    s.plans.setPlan(task.id, { phases: [{ title: "Fresh", steps: [{ title: "x" }] }] }, "agent", {
      protectStarted: true,
    });
    expect(s.tasks.detail(task.id).phases.map((p) => p.title)).toEqual(["Fresh"]);
  });

  it("setPlan with protectStarted also protects todo steps that have notes", () => {
    const { s, task } = setup();
    const [a] = task.phases[0]!.steps;
    s.plans.updateStep(a!.id, { notes: "worth keeping" }, "agent");
    expect(
      codeOf(() =>
        s.plans.setPlan(task.id, { phases: [{ title: "Other", steps: [{ title: "x" }] }] }, "agent", {
          protectStarted: true,
        }),
      ),
    ).toBe("CONFLICT");
  });

  describe("updatePlan", () => {
    function setupBig() {
      const h = setup();
      const second = h.s.plans.addPhase(h.task.id, "Two", "agent");
      h.s.plans.addSteps(second.id, [{ title: "c" }, { title: "d" }], "agent");
      const detail = h.s.tasks.detail(h.task.id);
      const titles = () => h.s.tasks.detail(h.task.id).phases.map((p) => p.steps.map((st) => st.title));
      return { ...h, detail, titles };
    }

    it("patches many steps and renames a phase in one call, leaving the rest alone", () => {
      const { s, task, detail, titles } = setupBig();
      const [a, b] = detail.phases[0]!.steps;
      const result = s.plans.updatePlan(
        task.id,
        {
          phases: [{ phase: "2", title: "Two renamed" }],
          steps: [
            { step: "1.1", status: "done", appendNotes: "shipped" },
            { step: b!.id, status: "in_progress" },
            { step: "2.2", title: "d renamed", notes: null },
          ],
        },
        "agent",
      );
      expect(result.phases.map((p) => p.title)).toEqual(["One", "Two renamed"]);
      expect(titles()).toEqual([
        ["a", "b"],
        ["c", "d renamed"],
      ]);
      expect(result.phases[0]!.steps.map((st) => [st.id, st.status, st.notes])).toEqual([
        [a!.id, "done", "shipped"],
        [b!.id, "in_progress", null],
      ]);
      const types = s.tasks.detail(task.id).events.map((e) => e.type);
      expect(types.filter((t) => t === "step_updated")).toHaveLength(3);
      expect(types.filter((t) => t === "phase_updated")).toHaveLength(1);
    });

    it("is all-or-nothing: one bad ref changes nothing", () => {
      const { s, task, titles } = setupBig();
      const before = s.tasks.detail(task.id);
      for (const bad of [
        { step: "9.9", status: "done" as const },
        { step: "1.1" },
        { step: "1.1", move: { before: "1.2", after: "2.1" } },
        { step: "1.1", move: {} },
      ]) {
        expect(
          codeOf(() => s.plans.updatePlan(task.id, { steps: [{ step: "1.2", status: "done" }, bad] }, "agent")),
        ).toMatch(/NOT_FOUND|VALIDATION/);
      }
      // A failure at apply time (anchor isn't a sibling in the target phase) rolls back the earlier edits too.
      expect(
        codeOf(() =>
          s.plans.updatePlan(
            task.id,
            {
              steps: [
                { step: "1.2", status: "done" },
                { step: "1.1", move: { phase: "2", before: "1.2" } },
              ],
            },
            "agent",
          ),
        ),
      ).toBe("VALIDATION");
      expect(codeOf(() => s.plans.updatePlan(task.id, {}, "agent"))).toBe("VALIDATION");
      const after = s.tasks.detail(task.id);
      expect(after.phases).toEqual(before.phases);
      expect(after.events).toHaveLength(before.events.length);
      expect(titles()).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    });

    it("resolves labels against the plan as it was before the call", () => {
      const { s, task, titles } = setupBig();
      // 1.1 moves out of phase 1, so "1.2" would become "1.1" if labels were resolved one edit at a time.
      s.plans.updatePlan(
        task.id,
        {
          steps: [
            { step: "1.1", move: { phase: "2" } },
            { step: "1.2", status: "done" },
            { step: "2.1", title: "c renamed" },
          ],
        },
        "agent",
      );
      expect(titles()).toEqual([["b"], ["c renamed", "d", "a"]]);
      expect(s.tasks.detail(task.id).phases[0]!.steps[0]).toMatchObject({ title: "b", status: "done" });
    });

    it("follows an anchor that was moved earlier in the same call", () => {
      const { s, task, titles } = setupBig();
      s.plans.updatePlan(
        task.id,
        {
          steps: [
            { step: "1.1", move: { phase: "2" } },
            { step: "1.2", move: { before: "1.1" } },
          ],
        },
        "agent",
      );
      expect(titles()).toEqual([[], ["c", "d", "b", "a"]]);
    });

    it("moves a step within a phase and next to a step in another phase", () => {
      const { s, task, titles } = setupBig();
      s.plans.updatePlan(task.id, { steps: [{ step: "1.2", move: { before: "1.1" } }] }, "agent");
      expect(titles()).toEqual([
        ["b", "a"],
        ["c", "d"],
      ]);
      // No phase given: the step goes to the anchor's phase.
      s.plans.updatePlan(task.id, { steps: [{ step: "1.1", move: { after: "2.1" } }] }, "agent");
      expect(titles()).toEqual([["a"], ["c", "b", "d"]]);
      // Phase only: appended at the end.
      s.plans.updatePlan(task.id, { steps: [{ step: "2.1", move: { phase: "1" } }] }, "agent");
      expect(titles()).toEqual([
        ["a", "c"],
        ["b", "d"],
      ]);
    });
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
