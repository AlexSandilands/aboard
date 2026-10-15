import type { PlanInput, PlanPhase, PlanStep, StepStatus } from "@repo/contracts";
import { generateNKeysBetween } from "fractional-indexing";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import type { PhaseRecord, StepRecord } from "../db/repos/plans.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound, planRequired } from "../errors.ts";
import { positionAmong, type Core, type Effects } from "./core.ts";
import type { PlansService } from "./types.ts";

/** Applies a status change to a step, maintaining started/completed timestamps. */
export function withStatus<T extends Pick<PlanStep, "status" | "startedAt" | "completedAt">>(
  step: T,
  status: StepStatus,
  now: string,
): T {
  if (step.status === status) return step;
  const done = status === "done" || status === "skipped";
  return {
    ...step,
    status,
    startedAt: status === "todo" ? null : status === "in_progress" ? (step.startedAt ?? now) : step.startedAt,
    completedAt: done ? now : null,
  };
}

const toPlanStep = ({ taskId: _taskId, ...step }: StepRecord): PlanStep => step;

export interface PlansModule {
  service: PlansService;
  /** Replaces a task's plan inside an open write (no detail returned). */
  replacePlan(task: TaskRecord, plan: PlanInput, actor: string, fx: Effects): void;
  /** Ordered phases with steps for one task. */
  phasesOf(taskId: string): PlanPhase[];
}

/** Plan phases and steps, including the plan gate. */
export function createPlans(
  core: Core,
  deps: { task: (id: string) => TaskRecord; detail: (id: string) => ReturnType<PlansService["setPlan"]> },
): PlansModule {
  const { repos } = core;

  const phaseOrThrow = (id: string): PhaseRecord => {
    const phase = repos.plans.phase(id);
    if (!phase) throw notFound("Phase", id);
    return phase;
  };
  const stepOrThrow = (id: string): StepRecord => {
    const step = repos.plans.step(id);
    if (!step) throw notFound("Step", id);
    return step;
  };
  const phasesOf = (taskId: string): PlanPhase[] => {
    const steps = repos.plans.stepsFor([taskId]);
    return repos.plans.phasesFor([taskId]).map((phase) => ({
      id: phase.id,
      title: phase.title,
      position: phase.position,
      steps: steps.filter((s) => s.phaseId === phase.id).map(toPlanStep),
    }));
  };
  /** Throws PLAN_REQUIRED if `remaining` steps would be left on a task outside Backlog. */
  const gate = (task: TaskRecord, remaining: number) => {
    if (remaining === 0 && task.status !== "backlog") throw planRequired(task.number);
  };
  const touchTask = (task: TaskRecord, now: string) => repos.tasks.update({ ...task, updatedAt: now });

  const newStep = (
    taskId: string,
    phaseId: string,
    input: PlanInput["phases"][number]["steps"][number],
    position: string,
    now: string,
  ): StepRecord =>
    withStatus(
      {
        id: randomUUID(),
        taskId,
        phaseId,
        title: input.title,
        notes: input.notes ?? null,
        status: "todo",
        position,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      },
      input.status ?? "todo",
      now,
    );

  const replacePlan: PlansModule["replacePlan"] = (task, plan, actor, fx) => {
    const stepCount = plan.phases.reduce((n, p) => n + p.steps.length, 0);
    gate(task, stepCount);
    const now = nowIso();
    const oldPhases = new Map(repos.plans.phasesFor([task.id]).map((p) => [p.id, p]));
    const oldSteps = new Map(repos.plans.stepsFor([task.id]).map((s) => [s.id, s]));
    const keptPhases = new Set<string>();
    const keptSteps = new Set<string>();
    const phaseKeys = generateNKeysBetween(null, null, plan.phases.length);

    plan.phases.forEach((phaseInput, pi) => {
      const existingPhase = phaseInput.id ? oldPhases.get(phaseInput.id) : undefined;
      const phase: PhaseRecord = existingPhase
        ? { ...existingPhase, title: phaseInput.title, position: phaseKeys[pi]!, updatedAt: now }
        : {
            id: randomUUID(),
            taskId: task.id,
            title: phaseInput.title,
            position: phaseKeys[pi]!,
            createdAt: now,
            updatedAt: now,
          };
      if (existingPhase) repos.plans.updatePhase(phase);
      else repos.plans.insertPhase(phase);
      keptPhases.add(phase.id);

      const stepKeys = generateNKeysBetween(null, null, phaseInput.steps.length);
      phaseInput.steps.forEach((stepInput, si) => {
        const existing = stepInput.id ? oldSteps.get(stepInput.id) : undefined;
        if (!existing || keptSteps.has(existing.id)) {
          repos.plans.insertStep(newStep(task.id, phase.id, stepInput, stepKeys[si]!, now));
          return;
        }
        const updated = withStatus(
          {
            ...existing,
            phaseId: phase.id,
            title: stepInput.title,
            notes: stepInput.notes !== undefined ? stepInput.notes : existing.notes,
            position: stepKeys[si]!,
            updatedAt: now,
          },
          stepInput.status ?? existing.status,
          now,
        );
        repos.plans.updateStep(updated);
        keptSteps.add(existing.id);
      });
    });

    for (const id of oldSteps.keys()) if (!keptSteps.has(id)) repos.plans.deleteStep(id);
    for (const id of oldPhases.keys()) if (!keptPhases.has(id)) repos.plans.deletePhase(id);
    touchTask({ ...task, planContext: plan.context !== undefined ? plan.context : task.planContext }, now);
    fx.log(task.id, actor, "plan_set", { phases: plan.phases.length, steps: stepCount });
  };

  const service: PlansService = {
    setPlan(taskId, plan, actor) {
      core.write((fx) => replacePlan(deps.task(taskId), plan, actor, fx));
      return deps.detail(taskId);
    },

    addPhase(taskId, title, actor, opts) {
      return core.write((fx) => {
        const task = deps.task(taskId);
        const now = nowIso();
        const siblings = repos.plans.phasesFor([taskId]);
        const phase: PhaseRecord = {
          id: randomUUID(),
          taskId,
          title: requireTitle(title),
          position: positionAmong(siblings, { afterId: opts?.afterPhaseId }),
          createdAt: now,
          updatedAt: now,
        };
        repos.plans.insertPhase(phase);
        touchTask(task, now);
        fx.log(taskId, actor, "phase_added", { phaseId: phase.id, title: phase.title });
        return { id: phase.id, title: phase.title, position: phase.position, steps: [] };
      });
    },

    updatePhase(phaseId, patch, actor) {
      return core.write((fx) => {
        const phase = phaseOrThrow(phaseId);
        const now = nowIso();
        const updated = { ...phase, title: requireTitle(patch.title), updatedAt: now };
        repos.plans.updatePhase(updated);
        touchTask(deps.task(phase.taskId), now);
        fx.log(phase.taskId, actor, "phase_updated", { phaseId, title: updated.title });
        return phasesOf(phase.taskId).find((p) => p.id === phaseId)!;
      });
    },

    deletePhase(phaseId, actor) {
      core.write((fx) => {
        const phase = phaseOrThrow(phaseId);
        const task = deps.task(phase.taskId);
        gate(task, repos.plans.countSteps(task.id) - repos.plans.stepsInPhase(phaseId).length);
        repos.plans.deletePhase(phaseId);
        touchTask(task, nowIso());
        fx.log(task.id, actor, "phase_deleted", { phaseId, title: phase.title });
      });
    },

    addSteps(phaseId, steps, actor, opts) {
      return core.write((fx) => {
        const phase = phaseOrThrow(phaseId);
        const task = deps.task(phase.taskId);
        if (steps.length === 0) throw new AppError("VALIDATION", "Provide at least one step");
        const now = nowIso();
        const siblings = repos.plans.stepsInPhase(phaseId);
        const created: StepRecord[] = [];
        let afterId = opts?.afterStepId ?? siblings.at(-1)?.id ?? null;
        let ordered: Array<{ id: string; position: string }> = siblings;
        for (const input of steps) {
          const step = newStep(task.id, phaseId, input, positionAmong(ordered, { afterId }), now);
          repos.plans.insertStep(step);
          created.push(step);
          ordered = [...ordered, step].sort((a, b) => (a.position < b.position ? -1 : 1));
          afterId = step.id;
        }
        touchTask(task, now);
        fx.log(task.id, actor, "steps_added", { phaseId, count: created.length });
        return created.map(toPlanStep);
      });
    },

    updateStep(stepId, patch, actor) {
      return core.write((fx) => {
        const step = stepOrThrow(stepId);
        const now = nowIso();
        let next: StepRecord = { ...step, updatedAt: now };
        if (patch.title !== undefined) next.title = patch.title;
        if (patch.notes !== undefined) next.notes = patch.notes;
        if (patch.appendNotes) next.notes = next.notes ? `${next.notes}\n\n${patch.appendNotes}` : patch.appendNotes;
        if (patch.status !== undefined) next = withStatus(next, patch.status, now);
        repos.plans.updateStep(next);
        touchTask(deps.task(step.taskId), now);
        fx.log(step.taskId, actor, "step_updated", {
          stepId,
          title: next.title,
          ...(next.status !== step.status ? { from: step.status, to: next.status } : {}),
        });
        return toPlanStep(next);
      });
    },

    moveStep(stepId, to, actor) {
      return core.write((fx) => {
        const step = stepOrThrow(stepId);
        const phaseId = to.phaseId ?? step.phaseId;
        if (phaseOrThrow(phaseId).taskId !== step.taskId) {
          throw new AppError("VALIDATION", "Steps can only move between phases of the same task");
        }
        const siblings = repos.plans.stepsInPhase(phaseId).filter((s) => s.id !== stepId);
        const now = nowIso();
        const moved = { ...step, phaseId, position: positionAmong(siblings, to), updatedAt: now };
        repos.plans.updateStep(moved);
        touchTask(deps.task(step.taskId), now);
        fx.log(step.taskId, actor, "step_moved", { stepId, title: step.title });
        return toPlanStep(moved);
      });
    },

    deleteStep(stepId, actor) {
      core.write((fx) => {
        const step = stepOrThrow(stepId);
        const task = deps.task(step.taskId);
        gate(task, repos.plans.countSteps(task.id) - 1);
        repos.plans.deleteStep(stepId);
        touchTask(task, nowIso());
        fx.log(task.id, actor, "step_deleted", { stepId, title: step.title });
      });
    },

    resolveStepId(taskId, ref) {
      const trimmed = ref.trim();
      const label = /^(\d+)\.(\d+)$/.exec(trimmed);
      if (label) {
        const step = phasesOf(taskId)[Number(label[1]) - 1]?.steps[Number(label[2]) - 1];
        if (!step) throw notFound("Step", trimmed);
        return step.id;
      }
      const step = repos.plans.step(trimmed);
      if (!step || step.taskId !== taskId) throw notFound("Step", trimmed);
      return step.id;
    },
  };

  return { service, replacePlan, phasesOf };
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new AppError("VALIDATION", "Title must not be empty");
  return trimmed;
}
