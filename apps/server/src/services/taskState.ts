import type {
  CopiedEvent,
  CopiedPhase,
  CopiedReview,
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
/**
 * `prSnapshots`: a runner's state carries what it read of the task's pull requests too, since its Autopilot polls
 * them and the board leaves them alone while the machine holds the task (remote-machines.md#autopilot-on-the-machine).
 */
export function readTaskState(repos: Repos, task: TaskRecord, opts: { prSnapshots?: boolean } = {}): TaskState {
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
      // A session on a machine is read there, so what was read goes with the task; any other link each side reads.
      ...(onMachine(row) || (opts.prSnapshots && row.kind === "pr") ? { snapshot: row.snapshot_json } : {}),
    })),
    blockedBy: relations.filter((r) => r.blockedId === task.id).map((r) => r.blockerId),
    blocks: relations.filter((r) => r.blockerId === task.id).map((r) => r.blockedId),
    reviews: readReviews(repos, task.id),
  };
}

function readReviews(repos: Repos, taskId: string): CopiedReview[] {
  const findings = repos.reviews.findingsFor([taskId]);
  return repos.reviews.forTasks([taskId]).map(({ taskId: _task, ...round }) => ({
    ...round,
    findings: findings
      .filter((f) => f.reviewId === round.id)
      .map(({ taskId: _t, reviewId: _r, round: _n, ...finding }) => finding),
  }));
}

/** Writes the task's review rounds as the state has them: the rounds of a held task are its machine's. */
function writeReviews(repos: Repos, taskId: string, reviews: readonly CopiedReview[]): void {
  const haveRounds = new Map(repos.reviews.forTasks([taskId]).map((r) => [r.id, r]));
  const haveFindings = new Map(repos.reviews.findingsFor([taskId]).map((f) => [f.id, f]));
  const keptRounds = new Set(reviews.map((r) => r.id));
  const keptFindings = new Set(reviews.flatMap((r) => r.findings.map((f) => f.id)));
  // First what the state no longer has: a round's number is unique in its task.
  for (const id of haveFindings.keys()) if (!keptFindings.has(id)) repos.reviews.deleteFinding(id);
  for (const id of haveRounds.keys()) if (!keptRounds.has(id)) repos.reviews.delete(id);
  for (const { findings, ...round } of reviews) {
    const record = { ...round, taskId };
    if (haveRounds.has(round.id)) repos.reviews.update(record);
    else repos.reviews.insert(record);
    for (const finding of findings) {
      const row = {
        ...finding,
        taskId,
        reviewId: round.id,
        round: round.round,
      };
      if (haveFindings.has(finding.id)) repos.reviews.updateFinding(row);
      else repos.reviews.insertFinding(row);
    }
  }
}

/** Whether a link is an agent session that ran on a connected machine: its ref names the machine. */
function onMachine(row: { kind: string; ref_json: string | null }): boolean {
  if (row.kind !== "agent_session" || !row.ref_json) return false;
  try {
    return Boolean((JSON.parse(row.ref_json) as { machine?: unknown }).machine);
  } catch {
    return false;
  }
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

  // The plan: phases first, then steps, then what the state no longer has, so a step that moved to another phase is
  // re-homed before its old phase goes (deleting a phase takes its steps with it).
  const stepIds = new Set(state.phases.flatMap((p) => p.steps.map((s) => s.id)));
  const phaseIds = new Set(state.phases.map((p) => p.id));
  const haveSteps = new Map(repos.plans.stepsFor([task.id]).map((s) => [s.id, s]));
  const havePhases = new Map(repos.plans.phasesFor([task.id]).map((p) => [p.id, p]));
  for (const phase of state.phases) {
    const record = {
      id: phase.id,
      taskId: task.id,
      title: phase.title,
      position: phase.position,
    };
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
      if (link.snapshot !== undefined) repos.links.setSnapshot(link.id, link.snapshot, state.task.updatedAt);
    } else {
      repos.links.insert({
        id: link.id,
        task_id: task.id,
        kind: link.kind,
        url: link.url,
        label: link.label,
        ref_json: link.ref,
        snapshot_json: link.snapshot ?? null,
        synced_at: link.snapshot ? state.task.updatedAt : null,
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
  // A state from before rounds travelled says nothing of them: this side's stay.
  if (state.reviews) writeReviews(repos, task.id, state.reviews);
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
