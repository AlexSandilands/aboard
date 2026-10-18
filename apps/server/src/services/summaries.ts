import {
  deriveAttention,
  isBlocked,
  deriveReviewSummary,
  deriveCurrentStep,
  deriveEpicRollup,
  deriveProgress,
  type PlanPhase,
  type PlanStep,
  type TaskRef,
  type TaskImport,
  type TaskRelation,
  type TaskReview,
  type TaskSummary,
} from "@repo/contracts";
import type { Repos } from "../db/repos/index.ts";
import { toLink } from "../db/repos/links.ts";
import type { ImportRecord } from "../db/repos/imports.ts";
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

export function toTaskImport(record: ImportRecord | undefined): TaskImport | null {
  return record ? { status: record.status, error: record.error, sourceUrl: record.sourceUrl } : null;
}

export function taskRef(task: TaskRecord | undefined): TaskRef | null {
  return task ? { id: task.id, number: task.number, title: task.title } : null;
}

/** An integration epic's branch, for the epic itself and for its tasks; null otherwise. */
function integrationBranchOf(record: TaskRecord, parent: TaskRecord | undefined): string | null {
  const epic = record.kind === "epic" ? record : parent;
  return epic?.delivery === "integration" ? epic.integrationBranch : null;
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
  const refIds = [
    ...new Set(records.flatMap((r) => [r.resolvedByTaskId, r.parentId].filter((id): id is string => id !== null))),
  ];
  const referenced = new Map(repos.tasks.getMany(refIds).map((t) => [t.id, t]));
  const epicIds = records.filter((r) => r.kind === "epic").map((r) => r.id);
  const childrenByEpic = groupBy(
    repos.tasks.childrenOf(epicIds).filter((c) => c.archivedAt === null),
    (c) => c.parentId!,
  );
  const roundsByTask = groupBy(repos.reviews.forTasks(ids), (r) => r.taskId);
  const findingsByTask = groupBy(repos.reviews.findingsFor(ids), (f) => f.taskId);
  const labelsByTask = repos.labels.forTasks(ids);
  const relations = repos.relations.forTasks(ids);
  const related = new Map(
    repos.tasks.getMany([...new Set(relations.flatMap((r) => [r.blockerId, r.blockedId]))]).map((t) => [t.id, t]),
  );
  const toRelation = (id: string): TaskRelation | null => {
    const task = related.get(id);
    return task
      ? { id: task.id, number: task.number, title: task.title, status: task.status, archived: task.archivedAt !== null }
      : null;
  };
  const relatedTasks = (relatedIds: string[]): TaskRelation[] =>
    relatedIds
      .map((id) => toRelation(id))
      .filter((t): t is TaskRelation => t !== null)
      .sort((x, y) => x.number - y.number);
  const importsByTask = repos.imports.forTasks(ids);
  const autopilotByTask = repos.autopilotRuns.attentionFor(ids);
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
    const issueImport = toTaskImport(importsByTask.get(record.id));
    const blockedBy = relatedTasks(relations.filter((r) => r.blockedId === record.id).map((r) => r.blockerId));
    const summary: TaskSummary = {
      id: record.id,
      number: record.number,
      projectId: record.projectId,
      kind: record.kind,
      parent: taskRef(record.parentId ? referenced.get(record.parentId) : undefined),
      rollup: record.kind === "epic" ? deriveEpicRollup(childrenByEpic.get(record.id) ?? []) : null,
      title: record.title,
      status: record.status,
      position: record.position,
      archivedAt: record.archivedAt,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      statusChangedAt: record.statusChangedAt,
      labels: labelsByTask.get(record.id) ?? [],
      blockedBy,
      blocks: relatedTasks(relations.filter((r) => r.blockerId === record.id).map((r) => r.blockedId)),
      blocked: isBlocked(blockedBy),
      resolution: record.resolution,
      resolvedBy: taskRef(record.resolvedByTaskId ? referenced.get(record.resolvedByTaskId) : undefined),
      progress: deriveProgress(phases),
      stepStatuses: phases.flatMap((p) => p.steps.map((s) => s.status)),
      currentStep: deriveCurrentStep(phases),
      links,
      // A finished task's review is history: the badge stays, the call to action doesn't.
      attention: deriveAttention(
        phases,
        links,
        record.status === "done" ? null : review,
        issueImport,
        autopilotByTask.get(record.id) ?? null,
      ),
      lastNote: note
        ? { text: typeof note.payload.text === "string" ? note.payload.text : "", actor: note.actor, at: note.at }
        : null,
      autoReview: record.autoReview,
      autopilot: record.autopilot,
      autoMerge: record.autoMerge,
      priority: record.priority,
      delivery: record.kind === "epic" ? record.delivery : null,
      integrationBranch: integrationBranchOf(record, record.parentId ? referenced.get(record.parentId) : undefined),
      review,
      suggestedModel: record.suggestedModel,
      import: issueImport,
    };
    result.set(record.id, { record, summary, phases, reviews: toTaskReviews(rounds, findings) });
  }
  return result;
}
