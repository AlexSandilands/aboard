import type {
  CopiedEvent,
  CopiedPhase,
  CopiedTaskFields,
  TaskEvent,
  TaskIdentity,
  TaskReference,
  TaskState,
} from "@repo/contracts";
import type { Repos } from "../db/repos/index.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";

// A held task's state as a board and its machine exchange it (remote-machines.md#held-tasks): reading it out of one
// database and writing it into the other. Both sides run the same server, so both use these.

const fieldsOf = (task: TaskRecord): CopiedTaskFields => ({
  title: task.title,
  description: task.description,
  planContext: task.planContext,
  status: task.status,
  statusChangedAt: task.statusChangedAt,
  updatedAt: task.updatedAt,
  resolution: task.resolution,
  resolvedByTaskId: task.resolvedByTaskId,
  autoReview: task.autoReview,
  reviewModel: task.reviewModel,
  autopilot: task.autopilot,
  autoMerge: task.autoMerge,
  priority: task.priority,
  manual: task.manual,
  dueDate: task.dueDate,
  attentionRequest: task.attentionRequest,
  suggestedModel: task.suggestedModel,
});

/** The task's state as it stands in this database. */
export function readTaskState(repos: Repos, task: TaskRecord): TaskState {
  const steps = repos.plans.stepsFor([task.id]);
  const phases: CopiedPhase[] = repos.plans.phasesFor([task.id]).map((phase) => ({
    id: phase.id,
    title: phase.title,
    position: phase.position,
    createdAt: phase.createdAt,
    updatedAt: phase.updatedAt,
    steps: steps
      .filter((s) => s.phaseId === phase.id)
      .map((s) => ({
        id: s.id,
        title: s.title,
        notes: s.notes,
        status: s.status,
        position: s.position,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        updatedAt: s.updatedAt,
      })),
  }));
  const relations = repos.relations.allFor([task.id]);
  return {
    task: fieldsOf(task),
    labels: repos.labels.forTasks([task.id]).get(task.id) ?? [],
    phases,
    links: repos.links.forTasks([task.id]).map((row) => ({
      id: row.id,
      kind: row.kind,
      url: row.url,
      label: row.label,
      ref: row.ref_json,
      createdAt: row.created_at,
      auto: row.auto !== 0,
    })),
    blockedBy: relations.filter((r) => r.blockedId === task.id).map((r) => r.blockerId),
    blocks: relations.filter((r) => r.blockerId === task.id).map((r) => r.blockedId),
  };
}

export const identityOf = (task: TaskRecord): TaskIdentity => ({
  id: task.id,
  numberPrefix: task.numberPrefix,
  number: task.number,
  kind: task.kind,
  createdBy: task.createdBy,
  createdAt: task.createdAt,
});

export const referenceOf = (task: TaskRecord): TaskReference => ({
  id: task.id,
  numberPrefix: task.numberPrefix,
  number: task.number,
  kind: task.kind,
  title: task.title,
  status: task.status,
  archived: task.archivedAt !== null,
  delivery: task.delivery,
  integrationBranch: task.integrationBranch,
});

export const copiedEvent = (event: TaskEvent): CopiedEvent => ({
  at: event.at,
  actor: event.actor,
  type: event.type,
  payload: event.payload,
});

/** The tasks a state points at, other than `task` itself: its epic, its blockers, what it blocks, its resolver. */
export function referencedIds(task: Pick<TaskRecord, "id" | "parentId">, state: TaskState): string[] {
  return [
    ...new Set(
      [task.parentId, state.task.resolvedByTaskId, ...state.blockedBy, ...state.blocks].filter(
        (id): id is string => id !== null && id !== task.id,
      ),
    ),
  ];
}

/**
 * Writes `state` onto `task`, leaving what the state doesn't carry (its project, epic, place in the lane, archive
 * and trash stamps) as `task` has them. Pointers at tasks this database doesn't have are dropped. With `blocks`,
 * the tasks it blocks are set too: only a runner taking a task does that, since on a board those relations are
 * edited from the other task. Returns the task as saved.
 */
export function writeTaskState(
  repos: Repos,
  task: TaskRecord,
  state: TaskState,
  opts: { blocks?: boolean; actor: string },
): TaskRecord {
  const exists = (id: string): boolean => repos.tasks.getAny(id) !== null;
  const resolvedBy = state.task.resolvedByTaskId;
  const next: TaskRecord = {
    ...task,
    ...state.task,
    resolvedByTaskId: resolvedBy && exists(resolvedBy) ? resolvedBy : null,
  };
  repos.tasks.update(next);
  repos.labels.replace(task.id, state.labels);

  // The plan: what the state no longer has goes first, so a step that moved phases never meets a deleted phase.
  const stepIds = new Set(state.phases.flatMap((p) => p.steps.map((s) => s.id)));
  const phaseIds = new Set(state.phases.map((p) => p.id));
  const haveSteps = new Map(repos.plans.stepsFor([task.id]).map((s) => [s.id, s]));
  const havePhases = new Map(repos.plans.phasesFor([task.id]).map((p) => [p.id, p]));
  for (const phase of state.phases) {
    const record = { id: phase.id, taskId: task.id, title: phase.title, position: phase.position };
    const stamps = { createdAt: phase.createdAt, updatedAt: phase.updatedAt };
    if (havePhases.has(phase.id)) repos.plans.updatePhase({ ...record, ...stamps });
    else repos.plans.insertPhase({ ...record, ...stamps });
  }
  for (const phase of state.phases) {
    for (const step of phase.steps) {
      const record = { ...step, phaseId: phase.id, taskId: task.id };
      if (haveSteps.has(step.id)) repos.plans.updateStep(record);
      else repos.plans.insertStep(record);
    }
  }
  for (const id of haveSteps.keys()) if (!stepIds.has(id)) repos.plans.deleteStep(id);
  for (const id of havePhases.keys()) if (!phaseIds.has(id)) repos.plans.deletePhase(id);

  // Links: one already here under another id (the same kind and URL) takes the state's id and keeps what this
  // side's poller read of it.
  const haveLinks = repos.links.forTasks([task.id]);
  const linkIds = new Set(state.links.map((l) => l.id));
  const kept = new Set<string>();
  for (const link of state.links) {
    const same = haveLinks.find((row) => row.id === link.id);
    const twin =
      same ?? haveLinks.find((row) => row.kind === link.kind && row.url === link.url && !linkIds.has(row.id));
    if (twin) kept.add(twin.id);
  }
  for (const row of haveLinks) if (!kept.has(row.id)) repos.links.delete(row.id);
  for (const link of state.links) {
    const same = haveLinks.find((row) => row.id === link.id);
    const twin = same ?? haveLinks.find((row) => kept.has(row.id) && row.kind === link.kind && row.url === link.url);
    if (twin) {
      if (twin.id !== link.id) repos.links.reId(twin.id, link.id);
      repos.links.setCopied(link.id, link.label, link.ref, link.auto, link.createdAt);
    } else {
      repos.links.insert({
        id: link.id,
        task_id: task.id,
        kind: link.kind,
        url: link.url,
        label: link.label,
        ref_json: link.ref,
        snapshot_json: null,
        synced_at: null,
        created_at: link.createdAt,
        auto: link.auto ? 1 : 0,
      });
    }
  }

  const relations = repos.relations.allFor([task.id]);
  const setSide = (wanted: readonly string[], side: "blockedBy" | "blocks"): void => {
    const want = new Set(wanted.filter((id) => id !== task.id && exists(id)));
    const have = relations
      .filter((r) => (side === "blockedBy" ? r.blockedId : r.blockerId) === task.id)
      .map((r) => (side === "blockedBy" ? r.blockerId : r.blockedId));
    for (const id of have) {
      if (want.has(id)) continue;
      if (side === "blockedBy") repos.relations.remove(id, task.id);
      else repos.relations.remove(task.id, id);
    }
    for (const id of want) {
      if (have.includes(id)) continue;
      if (side === "blockedBy") repos.relations.add(id, task.id, state.task.updatedAt, opts.actor);
      else repos.relations.add(task.id, id, state.task.updatedAt, opts.actor);
    }
  };
  setSide(state.blockedBy, "blockedBy");
  if (opts.blocks) setSide(state.blocks, "blocks");
  return next;
}

/** A task row with nothing set but what every row needs. */
export function blankTask(
  id: string,
  number: number,
  numberPrefix: string,
  projectId: string,
  now: string,
): TaskRecord {
  return {
    id,
    number,
    numberPrefix,
    projectId,
    kind: "task",
    parentId: null,
    title: "",
    description: null,
    planContext: null,
    status: "backlog",
    position: "a0",
    archivedAt: null,
    createdBy: "board",
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    resolution: null,
    resolvedByTaskId: null,
    autoReview: null,
    reviewModel: null,
    autopilot: null,
    autoMerge: null,
    priority: false,
    manual: false,
    dueDate: null,
    attentionRequest: null,
    suggestedModel: null,
    templateId: null,
    delivery: null,
    integrationBranch: null,
    integrationMergedAt: null,
    movedTo: null,
    deletedAt: null,
  };
}
