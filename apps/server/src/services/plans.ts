import type { PlanInput, PlanPhase, PlanStep, StepStatus } from "@repo/contracts";
import { generateNKeysBetween } from "fractional-indexing";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import type { PhaseRecord, StepRecord } from "../db/repos/plans.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound, planRequired } from "../errors.ts";
import { positionAmong, type Core, type Effects } from "./core.ts";
import type { PlanDeletion, PlansService } from "./types.ts";

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
  replacePlan(task: TaskRecord, plan: PlanInput, actor: string, fx: Effects, opts?: { protectStarted?: boolean }): void;
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

  const deletionsOf = (taskId: string, plan: PlanInput): PlanDeletion[] => {
    const kept = new Set(plan.phases.flatMap((p) => p.steps.map((s) => s.id)));
    return phasesOf(taskId).flatMap((phase, pi) =>
      phase.steps.flatMap((step, si) =>
        kept.has(step.id)
          ? []
          : [
              {
                label: `${pi + 1}.${si + 1}`,
                title: step.title,
                status: step.status,
                hasNotes: Boolean(step.notes?.trim()),
              },
            ],
      ),
    );
  };

  const replacePlan: PlansModule["replacePlan"] = (task, plan, actor, fx, opts) => {
    const stepCount = plan.phases.reduce((n, p) => n + p.steps.length, 0);
    gate(task, stepCount);
    const deleted = deletionsOf(task.id, plan);
    if (opts?.protectStarted) {
      const protectedSteps = deleted.filter((d) => d.status !== "todo" || d.hasNotes);
      if (protectedSteps.length > 0) throw wouldDelete(protectedSteps);
    }
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
    // Titles, so a plan wiped by mistake can be rebuilt from the activity log.
    fx.log(task.id, actor, "plan_set", {
      phases: plan.phases.length,
      steps: stepCount,
      ...(deleted.length > 0 ? { deleted: deleted.map((d) => `${d.label} ${d.title}`) } : {}),
    });
  };

  /** Resolves a "phase.step" label or step id against `plan` as it is now (not the live database). */
  const resolveIn = (plan: PlanPhase[], taskId: string, ref: string): string => {
    const trimmed = ref.trim();
    const label = /^(\d+)\.(\d+)$/.exec(trimmed);
    if (label) {
      const step = plan[Number(label[1]) - 1]?.steps[Number(label[2]) - 1];
      if (!step) throw notFound("Step", trimmed);
      return step.id;
    }
    const step = repos.plans.step(trimmed);
    if (!step || step.taskId !== taskId) throw notFound("Step", trimmed);
    return step.id;
  };

  const service: PlansService = {
    setPlan(taskId, plan, actor, opts) {
      core.write((fx) => replacePlan(deps.task(taskId), plan, actor, fx, opts));
      return deps.detail(taskId);
    },

    deletionsOf(taskId, plan) {
      deps.task(taskId);
      return deletionsOf(taskId, plan);
    },

    updatePlan(taskId, input, actor) {
      const stepEdits = input.steps ?? [];
      const phaseEdits = input.phases ?? [];
      if (stepEdits.length === 0 && phaseEdits.length === 0) {
        throw new AppError("VALIDATION", "Pass steps or phases to update.");
      }
      deps.task(taskId);
      core.write(() => {
        // Resolve every reference first: a move early in the batch must not shift what a later `2.3` points to.
        const plan = phasesOf(taskId);
        const phaseOf = new Map(plan.flatMap((p) => p.steps.map((s) => [s.id, p.id] as const)));
        const resolvePhase = (ref: string): string => {
          const trimmed = ref.trim();
          const found = /^\d+$/.test(trimmed) ? plan[Number(trimmed) - 1] : plan.find((p) => p.id === trimmed);
          if (!found) throw notFound("Phase", trimmed);
          return found.id;
        };

        const renames = phaseEdits.map((edit) => ({ phaseId: resolvePhase(edit.phase), title: edit.title }));
        const edits = stepEdits.map((edit) => {
          const { step, move, ...patch } = edit;
          const stepId = resolveIn(plan, taskId, step);
          const changes = Object.values(patch).some((v) => v !== undefined);
          if (!changes && !move) throw new AppError("VALIDATION", `Step ${step}: nothing to change.`);
          let to: Parameters<PlansService["moveStep"]>[1] | undefined;
          if (move) {
            if (move.before && move.after) {
              throw new AppError("VALIDATION", `Step ${step}: pass either before or after in move, not both.`);
            }
            const beforeId = move.before ? resolveIn(plan, taskId, move.before) : undefined;
            const afterId = move.after ? resolveIn(plan, taskId, move.after) : undefined;
            const phaseId = move.phase ? resolvePhase(move.phase) : (phaseOf.get((beforeId ?? afterId)!) ?? undefined);
            if (!phaseId && !beforeId && !afterId) {
              throw new AppError("VALIDATION", `Step ${step}: move needs a phase, before or after.`);
            }
            to = {
              ...(phaseId ? { phaseId } : {}),
              ...(beforeId ? { beforeId } : {}),
              ...(afterId ? { afterId } : {}),
            };
          }
          return { stepId, patch: changes ? patch : null, to };
        });

        for (const { phaseId, title } of renames) service.updatePhase(phaseId, { title }, actor);
        for (const { stepId, patch, to } of edits) {
          if (patch) service.updateStep(stepId, patch, actor);
          if (to) service.moveStep(stepId, to, actor);
        }
      });
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
      return resolveIn(phasesOf(taskId), taskId, ref);
    },
  };

  return { service, replacePlan, phasesOf };
}

const SHOWN_DELETIONS = 12;

/** CONFLICT for a replace that would drop steps with progress or notes; says which, so the agent can see what it'd lose. */
function wouldDelete(steps: PlanDeletion[]): AppError {
  const shown = steps.slice(0, SHOWN_DELETIONS).map((d) => {
    const why = [...(d.status !== "todo" ? [d.status] : []), ...(d.hasNotes ? ["notes"] : [])].join(", ");
    return `${d.label} "${d.title}" (${why})`;
  });
  const more = steps.length - shown.length;
  return new AppError(
    "CONFLICT",
    `This plan would delete ${steps.length} step(s) that have progress or notes: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. ` +
      "Steps and phases you leave out (or pass without their id) are deleted.",
    { steps },
  );
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new AppError("VALIDATION", "Title must not be empty");
  return trimmed;
}
