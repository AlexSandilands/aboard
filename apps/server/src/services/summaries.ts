import {
  deriveAttention,
  deriveCurrentStep,
  deriveProgress,
  type PlanPhase,
  type PlanStep,
  type TaskSummary,
} from "@taskboard/contracts";
import type { Repos } from "../db/repos/index.ts";
import { toLink } from "../db/repos/links.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";

export interface AssembledTask {
  record: TaskRecord;
  summary: TaskSummary;
  phases: PlanPhase[];
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Builds summaries (and ordered phases) for many tasks with a fixed number of queries.
 * The returned map preserves the order of `records`.
 */
export function assembleSummaries(repos: Repos, records: readonly TaskRecord[]): Map<string, AssembledTask> {
  const ids = records.map((r) => r.id);
  const result = new Map<string, AssembledTask>();
  if (ids.length === 0) return result;

  const phasesByTask = groupBy(repos.plans.phasesFor(ids), (p) => p.taskId);
  const stepsByPhase = groupBy(repos.plans.stepsFor(ids), (s) => s.phaseId);
  const linksByTask = groupBy(repos.links.forTasks(ids).map(toLink), (l) => l.taskId);
  const notes = new Map(repos.events.lastNotes(ids).map((e) => [e.taskId, e]));

  for (const record of records) {
    const phases: PlanPhase[] = (phasesByTask.get(record.id) ?? []).map((phase) => ({
      id: phase.id,
      title: phase.title,
      position: phase.position,
      steps: (stepsByPhase.get(phase.id) ?? []).map(
        ({ taskId: _taskId, ...step }): PlanStep => step,
      ),
    }));
    const links = linksByTask.get(record.id) ?? [];
    const note = notes.get(record.id);
    const summary: TaskSummary = {
      id: record.id,
      number: record.number,
      projectId: record.projectId,
      title: record.title,
      status: record.status,
      position: record.position,
      archivedAt: record.archivedAt,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      statusChangedAt: record.statusChangedAt,
      progress: deriveProgress(phases),
      stepStatuses: phases.flatMap((p) => p.steps.map((s) => s.status)),
      currentStep: deriveCurrentStep(phases),
      links,
      attention: deriveAttention(phases, links),
      lastNote: note ? { text: String(note.payload.text ?? ""), actor: note.actor, at: note.at } : null,
    };
    result.set(record.id, { record, summary, phases });
  }
  return result;
}
