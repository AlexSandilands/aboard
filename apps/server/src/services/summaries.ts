import {
  deriveAttention,
  deriveReviewSummary,
  deriveCurrentStep,
  deriveProgress,
  type PlanPhase,
  type PlanStep,
  type TaskRef,
  type TaskReview,
  type TaskSummary,
} from "@repo/contracts";
import type { Repos } from "../db/repos/index.ts";
import { toLink } from "../db/repos/links.ts";
import type { FindingRecord, ReviewRecord } from "../db/repos/reviews.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { loadSettings } from "./settings.ts";

export interface AssembledTask {
  record: TaskRecord;
  summary: TaskSummary;
  phases: PlanPhase[];
  /** Review rounds, oldest first, with their findings. */
  reviews: TaskReview[];
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

/** Joins rounds with their findings in contract shape. */
export function toTaskReviews(rounds: readonly ReviewRecord[], findings: readonly FindingRecord[]): TaskReview[] {
  const byReview = groupBy(findings, (f) => f.reviewId);
  return rounds.map((round) => ({
    ...round,
    findings: (byReview.get(round.id) ?? []).map(({ taskId: _t, round: n, position, ...f }) => ({
      ...f,
      label: `R${n}.${position}`,
    })),
  }));
}

export function taskRef(task: TaskRecord | undefined): TaskRef | null {
  return task ? { id: task.id, number: task.number, title: task.title } : null;
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
  const resolverIds = [...new Set(records.flatMap((r) => (r.resolvedByTaskId ? [r.resolvedByTaskId] : [])))];
  const resolvers = new Map(repos.tasks.getMany(resolverIds).map((t) => [t.id, t]));
  const roundsByTask = groupBy(repos.reviews.forTasks(ids), (r) => r.taskId);
  const findingsByTask = groupBy(repos.reviews.findingsFor(ids), (f) => f.taskId);
  const { reviewMaxRounds } = loadSettings(repos);

  for (const record of records) {
    const phases: PlanPhase[] = (phasesByTask.get(record.id) ?? []).map((phase) => ({
      id: phase.id,
      title: phase.title,
      position: phase.position,
      steps: (stepsByPhase.get(phase.id) ?? []).map(({ taskId: _taskId, ...step }): PlanStep => step),
    }));
    const links = linksByTask.get(record.id) ?? [];
    const note = notes.get(record.id);
    const rounds = roundsByTask.get(record.id) ?? [];
    const findings = findingsByTask.get(record.id) ?? [];
    const review = deriveReviewSummary(rounds, findings, reviewMaxRounds);
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
      resolution: record.resolution,
      resolvedBy: taskRef(record.resolvedByTaskId ? resolvers.get(record.resolvedByTaskId) : undefined),
      progress: deriveProgress(phases),
      stepStatuses: phases.flatMap((p) => p.steps.map((s) => s.status)),
      currentStep: deriveCurrentStep(phases),
      links,
      // A finished task's review is history: the badge stays, the call to action doesn't.
      attention: deriveAttention(phases, links, record.status === "done" ? null : review),
      lastNote: note
        ? { text: typeof note.payload.text === "string" ? note.payload.text : "", actor: note.actor, at: note.at }
        : null,
      autoReview: record.autoReview,
      review,
    };
    result.set(record.id, { record, summary, phases, reviews: toTaskReviews(rounds, findings) });
  }
  return result;
}
