import {
  TASK_STATUSES,
  type AttentionReason,
  type BoardSnapshot,
  type Project,
  type TaskStatus,
  type TaskSummary,
} from "@repo/contracts";

export const STATUS_ORDER: ReadonlyArray<TaskStatus> = TASK_STATUSES.map((s) => s.value);
/** Done shows only the most recently finished tasks until the lane is expanded. */
export const DONE_PREVIEW_COUNT = 5;

export type LaneCells = Readonly<Record<TaskStatus, ReadonlyArray<TaskSummary>>>;

export interface Lane {
  project: Project;
  cells: LaneCells;
}

export interface BoardFilters {
  /** `?project=` id; unknown ids are ignored. */
  projectId: string | null;
  search: string;
  attentionOnly: boolean;
  /** Only cards with at least one PR link. */
  hasPrOnly: boolean;
}

function hasPr(task: TaskSummary): boolean {
  return task.links.some((link) => link.kind === "pr");
}

export function jiraKeys(task: TaskSummary): string[] {
  const keys: string[] = [];
  for (const link of task.links) if (link.kind === "jira") keys.push(link.ref.key);
  return keys;
}

/** Matches a card against the sidebar search: title, `#number` / bare number, or Jira key. */
export function matchesTaskSearch(task: TaskSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  if (task.title.toLowerCase().includes(query)) return true;
  const numberQuery = query.startsWith("#") ? query.slice(1) : query;
  if (/^\d+$/.test(numberQuery) && String(task.number).startsWith(numberQuery)) return true;
  return jiraKeys(task).some((key) => key.toLowerCase().includes(query));
}

function byPosition(a: TaskSummary, b: TaskSummary) {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

function byRecentStatusChange(a: TaskSummary, b: TaskSummary) {
  return a.statusChangedAt < b.statusChangedAt ? 1 : a.statusChangedAt > b.statusChangedAt ? -1 : 0;
}

function emptyCells(): Record<TaskStatus, TaskSummary[]> {
  return { idea: [], planned: [], in_progress: [], review: [], done: [] };
}

/**
 * Groups the board into one lane per project (in project order) and five cells per lane.
 * Cells are ordered by position, except Done which is newest-first. With a text, attention or PR
 * filter active, lanes without a match are dropped so results are easy to scan. `archived` tasks
 * (Show archived) join their lanes; the snapshot's copy wins if a task is in both.
 */
export function buildLanes(
  board: BoardSnapshot,
  filters: BoardFilters,
  archived: ReadonlyArray<TaskSummary> = [],
): Lane[] {
  const scoped = filters.projectId && board.projects.some((p) => p.id === filters.projectId) ? filters.projectId : null;
  const filtering = filters.search.trim() !== "" || filters.attentionOnly || filters.hasPrOnly;
  const byProject = new Map<string, Record<TaskStatus, TaskSummary[]>>();
  const active = new Set(board.tasks.map((task) => task.id));
  const tasks = archived.length ? [...board.tasks, ...archived.filter((task) => !active.has(task.id))] : board.tasks;
  for (const task of tasks) {
    if (scoped && task.projectId !== scoped) continue;
    if (filters.attentionOnly && task.attention.length === 0) continue;
    if (filters.hasPrOnly && !hasPr(task)) continue;
    if (!matchesTaskSearch(task, filters.search)) continue;
    let cells = byProject.get(task.projectId);
    if (!cells) byProject.set(task.projectId, (cells = emptyCells()));
    cells[task.status].push(task);
  }
  const lanes: Lane[] = [];
  for (const project of board.projects) {
    if (scoped && project.id !== scoped) continue;
    const cells = byProject.get(project.id);
    if (!cells && filtering) continue;
    const resolved = cells ?? emptyCells();
    for (const status of STATUS_ORDER) resolved[status].sort(status === "done" ? byRecentStatusChange : byPosition);
    lanes.push({ project, cells: resolved });
  }
  return lanes;
}

export function columnCounts(lanes: ReadonlyArray<Lane>): Record<TaskStatus, number> {
  const counts = { idea: 0, planned: 0, in_progress: 0, review: 0, done: 0 };
  for (const lane of lanes) for (const status of STATUS_ORDER) counts[status] += lane.cells[status].length;
  return counts;
}

function sameItems<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Reuses the previous lane, cell and array objects wherever their contents are unchanged, so
 * memoized lanes and cells skip re-rendering when an event touches some other part of the board.
 */
export function reuseUnchangedLanes(previous: ReadonlyArray<Lane>, next: Lane[]): Lane[] {
  const previousById = new Map(previous.map((lane) => [lane.project.id, lane]));
  return next.map((lane) => {
    const old = previousById.get(lane.project.id);
    if (!old) return lane;
    const cells: Record<TaskStatus, ReadonlyArray<TaskSummary>> = { ...lane.cells };
    let cellsChanged = false;
    for (const status of STATUS_ORDER) {
      if (sameItems(old.cells[status], lane.cells[status])) cells[status] = old.cells[status];
      else cellsChanged = true;
    }
    if (!cellsChanged && old.project === lane.project) return old;
    return { project: lane.project, cells: cellsChanged ? cells : old.cells };
  });
}

/** Errors outrank warnings. */
export function topAttention(reasons: ReadonlyArray<AttentionReason>): AttentionReason | null {
  return reasons.find((r) => r.severity === "error") ?? reasons[0] ?? null;
}

export const ATTENTION_LABELS: Record<AttentionReason["kind"], string> = {
  blocked_step: "Blocked",
  pr_checks_failing: "Checks failing",
  pr_changes_requested: "Changes requested",
  pr_conflict: "Conflict",
  thread_needs_input: "Needs input",
  thread_failed: "Thread failed",
};

/** Tasks for the sidebar's "Needs attention" list: errors first, then most recently updated. */
export function attentionTasks(tasks: ReadonlyArray<TaskSummary>): TaskSummary[] {
  const rank = (task: TaskSummary) => (task.attention.some((r) => r.severity === "error") ? 0 : 1);
  return tasks
    .filter((task) => task.attention.length > 0)
    .sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Open (not Done) task counts per project, for the sidebar project list. */
export function openTaskCounts(tasks: ReadonlyArray<TaskSummary>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks)
    if (task.status !== "done") counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  return counts;
}
