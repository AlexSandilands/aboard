import {
  deriveCurrentStep,
  deriveProgress,
  isStepComplete,
  type PlanInput,
  type PlanPhase,
  type PlanStep,
  type StepStatus,
  type TaskDetail,
} from "@taskboard/contracts";

/** Clicking a step's node walks todo → in_progress → done → todo; blocked/skipped reset to todo. */
export function cycleStepStatus(status: StepStatus): StepStatus {
  if (status === "todo") return "in_progress";
  if (status === "in_progress") return "done";
  return "todo";
}

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
  skipped: "Skipped",
};

/** Tone of the rail segment that connects `prev` to `current`. */
export type RailTone = "success" | "primary" | "default";

export function railSegmentTone(prev: StepStatus, current: StepStatus): RailTone {
  if (current === "in_progress") return "primary";
  if (isStepComplete(prev) && isStepComplete(current)) return "success";
  return "default";
}

/** Phases with the current step open; fully complete phases start collapsed. */
export function isPhaseOpenByDefault(phase: PlanPhase, currentStepId: string | null | undefined): boolean {
  if (currentStepId && phase.steps.some((s) => s.id === currentStepId)) return true;
  if (phase.steps.length > 0 && phase.steps.every((s) => isStepComplete(s.status))) return false;
  return true;
}

export function phaseProgress(phase: PlanPhase): { done: number; total: number } {
  return { done: phase.steps.filter((s) => isStepComplete(s.status)).length, total: phase.steps.length };
}

/** "1.2"-style labels for every step, keyed by id. */
export function stepIndexLabels(phases: ReadonlyArray<PlanPhase>): Map<string, { label: string; title: string }> {
  const map = new Map<string, { label: string; title: string }>();
  phases.forEach((phase, pi) =>
    phase.steps.forEach((step, si) => map.set(step.id, { label: `${pi + 1}.${si + 1}`, title: step.title })),
  );
  return map;
}

// ── Drag-and-drop ordering ───────────────────────────────────────────────

/** Step ids per phase, in display order. */
export type StepOrder = Readonly<Record<string, ReadonlyArray<string>>>;

/** Droppable id for a phase header (drop target for "start of this phase"). */
export const PHASE_DROP_PREFIX = "phase:";

export function stepOrderOf(phases: ReadonlyArray<PlanPhase>): StepOrder {
  return Object.fromEntries(phases.map((p) => [p.id, p.steps.map((s) => s.id)]));
}

export function phaseOfStep(order: StepOrder, stepId: string): string | undefined {
  return Object.keys(order).find((phaseId) => order[phaseId]!.includes(stepId));
}

/** Resolves a drop target (a step id or a phase header droppable) to its phase. */
export function phaseOfTarget(order: StepOrder, overId: string): string | undefined {
  if (overId.startsWith(PHASE_DROP_PREFIX)) {
    const phaseId = overId.slice(PHASE_DROP_PREFIX.length);
    return phaseId in order ? phaseId : undefined;
  }
  return phaseOfStep(order, overId);
}

/**
 * Moves `stepId` onto `overId`. Over a step in the same phase it takes that step's index
 * (dnd-kit arrayMove semantics); over a step in another phase it is inserted before it;
 * over a phase header it goes to the start of that phase. Returns the same object when
 * nothing changes.
 */
export function moveStepInOrder(order: StepOrder, stepId: string, overId: string): StepOrder {
  if (stepId === overId) return order;
  const from = phaseOfStep(order, stepId);
  const to = phaseOfTarget(order, overId);
  if (!from || !to) return order;
  const source = order[from]!.filter((id) => id !== stepId);
  const fromIndex = order[from]!.indexOf(stepId);

  let insertAt: number;
  if (overId.startsWith(PHASE_DROP_PREFIX)) {
    insertAt = 0;
  } else if (from === to) {
    insertAt = order[from]!.indexOf(overId);
  } else {
    insertAt = order[to]!.indexOf(overId);
  }

  if (from === to) {
    if (insertAt === fromIndex) return order;
    const next = [...source];
    next.splice(insertAt, 0, stepId);
    return { ...order, [from]: next };
  }
  const target = [...order[to]!];
  target.splice(insertAt, 0, stepId);
  return { ...order, [from]: source, [to]: target };
}

export interface StepPlacement {
  phaseId: string;
  /** The step that now follows the moved step, or null at the end. */
  beforeId: string | null;
  /** The step that now precedes the moved step, or null at the start. */
  afterId: string | null;
}

/** Where `stepId` sits in `order`, as the move API's phase + neighbours. */
export function placementOf(order: StepOrder, stepId: string): StepPlacement | null {
  const phaseId = phaseOfStep(order, stepId);
  if (!phaseId) return null;
  const ids = order[phaseId]!;
  const index = ids.indexOf(stepId);
  return { phaseId, beforeId: ids[index + 1] ?? null, afterId: ids[index - 1] ?? null };
}

/** True when the step's phase and neighbours are unchanged between two orders. */
export function samePlacement(a: StepOrder, b: StepOrder, stepId: string): boolean {
  const pa = placementOf(a, stepId);
  const pb = placementOf(b, stepId);
  return !!pa && !!pb && pa.phaseId === pb.phaseId && pa.beforeId === pb.beforeId && pa.afterId === pb.afterId;
}

// ── Optimistic detail patches ────────────────────────────────────────────

/** Replaces the plan and re-derives progress, step statuses and the current step. */
export function withPhases(detail: TaskDetail, phases: PlanPhase[]): TaskDetail {
  return {
    ...detail,
    phases,
    progress: deriveProgress(phases),
    stepStatuses: phases.flatMap((p) => p.steps.map((s) => s.status)),
    currentStep: deriveCurrentStep(phases),
  };
}

export function patchStep(
  detail: TaskDetail,
  stepId: string,
  patch: Partial<Pick<PlanStep, "title" | "notes" | "status">>,
): TaskDetail {
  return withPhases(
    detail,
    detail.phases.map((phase) =>
      phase.steps.some((s) => s.id === stepId)
        ? { ...phase, steps: phase.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) }
        : phase,
    ),
  );
}

export function removeStep(detail: TaskDetail, stepId: string): TaskDetail {
  return withPhases(
    detail,
    detail.phases.map((phase) => ({ ...phase, steps: phase.steps.filter((s) => s.id !== stepId) })),
  );
}

export function patchPhase(detail: TaskDetail, phaseId: string, patch: { title: string }): TaskDetail {
  return { ...detail, phases: detail.phases.map((p) => (p.id === phaseId ? { ...p, ...patch } : p)) };
}

export function removePhase(detail: TaskDetail, phaseId: string): TaskDetail {
  return withPhases(
    detail,
    detail.phases.filter((p) => p.id !== phaseId),
  );
}

/** Rebuilds each phase's steps from `order`, moving steps between phases as needed. */
export function applyStepOrder(detail: TaskDetail, order: StepOrder): TaskDetail {
  const steps = new Map(detail.phases.flatMap((p) => p.steps).map((s) => [s.id, s]));
  return withPhases(
    detail,
    detail.phases.map((phase) => ({
      ...phase,
      steps: (order[phase.id] ?? [])
        .map((id) => steps.get(id))
        .filter((s): s is PlanStep => s !== undefined)
        .map((s) => (s.phaseId === phase.id ? s : { ...s, phaseId: phase.id })),
    })),
  );
}

// ── Plan editor ──────────────────────────────────────────────────────────

export interface OutlineStep {
  key: string;
  id?: string;
  title: string;
  notes?: string;
  /** Shown in the editor; only sent for new steps, so saving never overwrites live progress. */
  status?: StepStatus;
}

export interface OutlinePhase {
  key: string;
  id?: string;
  title: string;
  steps: OutlineStep[];
}

let outlineKey = 0;
export const nextOutlineKey = () => `k${++outlineKey}`;

/** Outline draft from the current plan; ids are kept so step progress survives a save. */
export function outlineFromPhases(phases: ReadonlyArray<PlanPhase>): OutlinePhase[] {
  return phases.map((phase) => ({
    key: nextOutlineKey(),
    id: phase.id,
    title: phase.title,
    steps: phase.steps.map((step) => ({ key: nextOutlineKey(), id: step.id, title: step.title, status: step.status })),
  }));
}

/** Outline draft from a parsed (pasted) plan; no ids, so it replaces the plan. */
export function outlineFromPlanInput(plan: PlanInput): OutlinePhase[] {
  return plan.phases.map((phase) => ({
    key: nextOutlineKey(),
    title: phase.title,
    steps: phase.steps.map((step) => ({
      key: nextOutlineKey(),
      title: step.title,
      ...(step.notes ? { notes: step.notes } : {}),
      ...(step.status ? { status: step.status } : {}),
    })),
  }));
}

/** Converts an outline to a PlanInput: blank steps and empty phases are dropped, blank phase titles fall back. Null when it has no steps. */
export function planInputFromOutline(outline: ReadonlyArray<OutlinePhase>): PlanInput | null {
  const phases = outline
    .map((phase, index) => ({
      ...(phase.id ? { id: phase.id } : {}),
      title: phase.title.trim() || (outline.length === 1 ? "Plan" : `Phase ${index + 1}`),
      steps: phase.steps
        .filter((s) => s.title.trim())
        .map((s) => ({
          ...(s.id ? { id: s.id } : {}),
          title: s.title.trim(),
          ...(s.notes ? { notes: s.notes } : {}),
          ...(s.status && !s.id ? { status: s.status } : {}),
        })),
    }))
    .filter((phase) => phase.steps.length > 0);
  return phases.length > 0 ? { phases } : null;
}
