import type { PlanStep, StepStatus } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

export interface PhaseRecord {
  id: string;
  taskId: string;
  title: string;
  position: string;
  createdAt: string;
  updatedAt: string;
}

export interface StepRecord extends PlanStep {
  taskId: string;
}

interface PhaseRow {
  id: string;
  task_id: string;
  title: string;
  position: string;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  phase_id: string;
  task_id: string;
  title: string;
  notes: string | null;
  status: StepStatus;
  position: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

const toPhase = (r: PhaseRow): PhaseRecord => ({
  id: r.id,
  taskId: r.task_id,
  title: r.title,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toStep = (r: StepRow): StepRecord => ({
  id: r.id,
  phaseId: r.phase_id,
  taskId: r.task_id,
  title: r.title,
  notes: r.notes,
  status: r.status,
  position: r.position,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  updatedAt: r.updated_at,
});

const phaseRow = (p: PhaseRecord): PhaseRow => ({
  id: p.id,
  task_id: p.taskId,
  title: p.title,
  position: p.position,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
});

const stepRow = (s: StepRecord): StepRow => ({
  id: s.id,
  phase_id: s.phaseId,
  task_id: s.taskId,
  title: s.title,
  notes: s.notes,
  status: s.status,
  position: s.position,
  started_at: s.startedAt,
  completed_at: s.completedAt,
  updated_at: s.updatedAt,
});

/** Typed access to plan_phases and plan_steps. */
export function createPlansRepo(sql: Sql) {
  return {
    phase(id: string): PhaseRecord | null {
      const row = sql.get<PhaseRow>("SELECT * FROM plan_phases WHERE id = ?", id);
      return row ? toPhase(row) : null;
    },
    step(id: string): StepRecord | null {
      const row = sql.get<StepRow>("SELECT * FROM plan_steps WHERE id = ?", id);
      return row ? toStep(row) : null;
    },
    /** Phases for the given tasks, ordered by position. */
    phasesFor(taskIds: readonly string[]): PhaseRecord[] {
      return sql
        .all<PhaseRow>(
          "SELECT * FROM plan_phases WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY position, id",
          jsonList(taskIds),
        )
        .map(toPhase);
    },
    /** Steps for the given tasks, ordered by position (group by phase to get plan order). */
    stepsFor(taskIds: readonly string[]): StepRecord[] {
      return sql
        .all<StepRow>(
          "SELECT * FROM plan_steps WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY position, id",
          jsonList(taskIds),
        )
        .map(toStep);
    },
    stepsInPhase(phaseId: string): StepRecord[] {
      return sql
        .all<StepRow>("SELECT * FROM plan_steps WHERE phase_id = ? ORDER BY position, id", phaseId)
        .map(toStep);
    },
    countSteps(taskId: string): number {
      return Number(sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM plan_steps WHERE task_id = ?", taskId)?.n ?? 0);
    },
    insertPhase(p: PhaseRecord): void {
      sql.insert("plan_phases", { ...phaseRow(p) });
    },
    updatePhase(p: PhaseRecord): void {
      sql.update("plan_phases", { ...phaseRow(p) });
    },
    deletePhase(id: string): void {
      sql.run("DELETE FROM plan_phases WHERE id = ?", id);
    },
    insertStep(s: StepRecord): void {
      sql.insert("plan_steps", { ...stepRow(s) });
    },
    updateStep(s: StepRecord): void {
      sql.update("plan_steps", { ...stepRow(s) });
    },
    deleteStep(id: string): void {
      sql.run("DELETE FROM plan_steps WHERE id = ?", id);
    },
  };
}
export type PlansRepo = ReturnType<typeof createPlansRepo>;
