import type { PlanPhase, PlanStep, StepStatus, TaskDetail } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyStepOrder,
  cycleStepStatus,
  isPhaseOpenByDefault,
  moveStepInOrder,
  patchStep,
  PHASE_DROP_PREFIX,
  placementOf,
  planInputFromOutline,
  railSegmentTone,
  samePlacement,
  stepOrderOf,
  type StepOrder,
} from "./plan.logic";

function step(id: string, phaseId: string, status: StepStatus = "todo"): PlanStep {
  return {
    id,
    phaseId,
    title: id.toUpperCase(),
    notes: null,
    status,
    position: id,
    startedAt: null,
    completedAt: null,
    updatedAt: "",
  };
}

function phase(id: string, steps: Array<[string, StepStatus?]>): PlanPhase {
  return { id, title: id, position: id, steps: steps.map(([s, status]) => step(s, id, status)) };
}

function detail(phases: PlanPhase[]): TaskDetail {
  return {
    id: "t",
    number: 1,
    projectId: "p",
    kind: "task",
    parent: null,
    rollup: null,
    title: "T",
    status: "planned",
    position: "a",
    archivedAt: null,
    createdBy: "user",
    createdAt: "",
    updatedAt: "",
    statusChangedAt: "",
    labels: [],
    blockedBy: [],
    blocks: [],
    blocked: false,
    resolution: null,
    resolvedBy: null,
    progress: { done: 0, total: 0 },
    stepStatuses: [],
    currentStep: null,
    links: [],
    attention: [],
    attentionRequest: null,
    lastNote: null,
    autoReview: null,
    autopilot: null,
    autoMerge: null,
    priority: false,
    delivery: null,
    integrationBranch: null,
    review: null,
    suggestedModel: null,
    import: null,
    description: null,
    planContext: null,
    phases,
    events: [],
    resolves: [],
    reviews: [],
    children: [],
  };
}

describe("cycleStepStatus", () => {
  it("walks todo → in_progress → done → todo", () => {
    expect(cycleStepStatus("todo")).toBe("in_progress");
    expect(cycleStepStatus("in_progress")).toBe("done");
    expect(cycleStepStatus("done")).toBe("todo");
  });
  it("resets blocked and skipped to todo", () => {
    expect(cycleStepStatus("blocked")).toBe("todo");
    expect(cycleStepStatus("skipped")).toBe("todo");
  });
});

describe("railSegmentTone", () => {
  it("tints between completed steps and into the in-progress step", () => {
    expect(railSegmentTone("done", "skipped")).toBe("success");
    expect(railSegmentTone("done", "in_progress")).toBe("primary");
    expect(railSegmentTone("todo", "in_progress")).toBe("primary");
    expect(railSegmentTone("done", "todo")).toBe("default");
    expect(railSegmentTone("in_progress", "todo")).toBe("default");
  });
});

describe("isPhaseOpenByDefault", () => {
  it("opens the current phase and collapses finished ones", () => {
    expect(
      isPhaseOpenByDefault(
        phase("a", [
          ["s1", "done"],
          ["s2", "done"],
        ]),
        null,
      ),
    ).toBe(false);
    expect(
      isPhaseOpenByDefault(
        phase("a", [
          ["s1", "done"],
          ["s2", "skipped"],
        ]),
        "s2",
      ),
    ).toBe(true);
    expect(isPhaseOpenByDefault(phase("a", [["s1", "todo"]]), "other")).toBe(true);
    expect(isPhaseOpenByDefault(phase("a", []), null)).toBe(true);
  });
});

describe("moveStepInOrder", () => {
  const order: StepOrder = { a: ["a1", "a2", "a3"], b: ["b1", "b2"], c: [] };

  it("moves within a phase with arrayMove semantics", () => {
    expect(moveStepInOrder(order, "a1", "a3").a).toEqual(["a2", "a3", "a1"]);
    expect(moveStepInOrder(order, "a3", "a1").a).toEqual(["a3", "a1", "a2"]);
  });

  it("inserts before the target step in another phase", () => {
    const next = moveStepInOrder(order, "a2", "b2");
    expect(next.a).toEqual(["a1", "a3"]);
    expect(next.b).toEqual(["b1", "a2", "b2"]);
  });

  it("drops onto a phase header at the start of that phase", () => {
    expect(moveStepInOrder(order, "a3", `${PHASE_DROP_PREFIX}b`).b).toEqual(["a3", "b1", "b2"]);
    expect(moveStepInOrder(order, "a3", `${PHASE_DROP_PREFIX}c`).c).toEqual(["a3"]);
    expect(moveStepInOrder(order, "a3", `${PHASE_DROP_PREFIX}a`).a).toEqual(["a3", "a1", "a2"]);
  });

  it("returns the same object when nothing changes", () => {
    expect(moveStepInOrder(order, "a1", "a1")).toBe(order);
    expect(moveStepInOrder(order, "a1", `${PHASE_DROP_PREFIX}a`)).toBe(order);
    expect(moveStepInOrder(order, "a1", "missing")).toBe(order);
  });
});

describe("placementOf", () => {
  it("reports the phase and neighbours for the move API", () => {
    const order: StepOrder = { a: ["a1", "a2", "a3"], b: ["x"] };
    expect(placementOf(order, "a2")).toEqual({ phaseId: "a", beforeId: "a3", afterId: "a1" });
    expect(placementOf(order, "a1")).toEqual({ phaseId: "a", beforeId: "a2", afterId: null });
    expect(placementOf(order, "x")).toEqual({ phaseId: "b", beforeId: null, afterId: null });
    expect(placementOf(order, "nope")).toBeNull();
  });

  it("detects a no-op drag", () => {
    const order: StepOrder = { a: ["a1", "a2"], b: [] };
    expect(samePlacement(order, moveStepInOrder(order, "a1", "a1"), "a1")).toBe(true);
    expect(samePlacement(order, moveStepInOrder(order, "a1", "a2"), "a1")).toBe(false);
  });
});

describe("optimistic patches", () => {
  const base = detail([
    phase("a", [
      ["a1", "done"],
      ["a2", "todo"],
    ]),
    phase("b", [["b1", "todo"]]),
  ]);

  it("re-derives progress and the current step after a status change", () => {
    const next = patchStep(base, "a2", { status: "in_progress" });
    expect(next.currentStep?.id).toBe("a2");
    expect(next.currentStep?.status).toBe("in_progress");
    expect(next.stepStatuses).toEqual(["done", "in_progress", "todo"]);
    const done = patchStep(next, "a2", { status: "done" });
    expect(done.progress).toEqual({ done: 2, total: 3 });
    expect(done.currentStep?.id).toBe("b1");
  });

  it("applies a cross-phase order and updates phaseId", () => {
    const next = applyStepOrder(base, moveStepInOrder(stepOrderOf(base.phases), "a2", "b1"));
    expect(stepOrderOf(next.phases)).toEqual({ a: ["a1"], b: ["a2", "b1"] });
    expect(next.phases[1]!.steps[0]!.phaseId).toBe("b");
  });
});

describe("planInputFromOutline", () => {
  it("keeps ids, drops blank steps and empty phases", () => {
    expect(
      planInputFromOutline([
        {
          key: "1",
          id: "p1",
          title: " Build ",
          steps: [
            { key: "2", id: "s1", title: "One" },
            { key: "3", title: "  " },
          ],
        },
        { key: "4", title: "Empty", steps: [{ key: "5", title: "" }] },
      ]),
    ).toEqual({ phases: [{ id: "p1", title: "Build", steps: [{ id: "s1", title: "One" }] }] });
  });

  it("sends status only for new steps so live progress is never overwritten", () => {
    expect(
      planInputFromOutline([
        {
          key: "1",
          title: "A",
          steps: [
            { key: "2", id: "s1", title: "Kept", status: "done" },
            { key: "3", title: "Pasted", status: "done" },
          ],
        },
      ]),
    ).toEqual({
      phases: [
        {
          title: "A",
          steps: [
            { id: "s1", title: "Kept" },
            { title: "Pasted", status: "done" },
          ],
        },
      ],
    });
  });

  it("names untitled phases and returns null without steps", () => {
    expect(planInputFromOutline([{ key: "1", title: "", steps: [{ key: "2", title: "Do it" }] }])).toEqual({
      phases: [{ title: "Plan", steps: [{ title: "Do it" }] }],
    });
    expect(planInputFromOutline([{ key: "1", title: "A", steps: [] }])).toBeNull();
  });
});
