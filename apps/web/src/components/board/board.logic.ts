import {
  TASK_STATUSES,
  type AttentionReason,
  type BoardSnapshot,
  type Project,
  type TaskStatus,
  type TaskSummary,
} from "@repo/contracts";

export const STATUS_ORDER: ReadonlyArray<TaskStatus> = TASK_STATUSES.map((s) => s.value);
/** A collapsed column shows only the first few cards of each lane until it is expanded. */
export const COLUMN_PREVIEW_COUNT = 5;

export type LaneCells = Readonly<Record<TaskStatus, ReadonlyArray<TaskSummary>>>;

/**
 * An epic's row in its project lane. It spans only the columns its children are in (`start` to `end`,
 * indexes into STATUS_ORDER); an epic with no children shows in Backlog. Its id is the epic's id.
 */
export interface EpicBand {
  id: string;
  epic: TaskSummary;
  cells: LaneCells;
  start: number;
  end: number;
}

/**
 * The priority lane's row id. It is a lane above every project that holds the priority tasks of all of them, so
 * it can't be a project's id; the cards in it keep their own project and can only change column there.
 */
export const PRIORITY_ROW_ID = "priority";

/** Stands in for the priority lane's project, so lanes keep one shape. Only its id and title are used. */
export const PRIORITY_PROJECT: Project = {
  id: PRIORITY_ROW_ID,
  title: "Priority",
  workspaceRoot: null,
  workspaceKey: null,
  icon: null,
  t3ProjectId: null,
  reviewSkill: null,
  position: "",
  collapsed: false,
  archivedAt: null,
  createdAt: "",
  updatedAt: "",
};

export interface Lane {
  /** True for the priority lane: `project` is PRIORITY_PROJECT, `cells` span every project and there are no bands. */
  priority?: true;
  project: Project;
  /** Epic bands (epics not yet Done), stacked above the loose cards in the epics' Backlog order. */
  bands: ReadonlyArray<EpicBand>;
  /** Cards in no epic, or whose epic isn't shown. A finished epic is one of them, in Done. */
  cells: LaneCells;
  /** The tasks of each finished epic card in `cells.done`, by epic id: shown inside the card, not loose. */
  epicChildren: Readonly<Record<string, ReadonlyArray<TaskSummary>>>;
}

/**
 * Cards move by dragging only within their row: the project's loose cards (row id = project id) or one
 * epic band (row id = epic id). Joining or leaving an epic happens in the panel.
 */
export interface Row {
  id: string;
  projectId: string;
  cells: LaneCells;
}

export function laneRows(lane: Pick<Lane, "project" | "bands" | "cells">): Row[] {
  return [
    ...lane.bands.map((band) => ({ id: band.id, projectId: lane.project.id, cells: band.cells })),
    { id: lane.project.id, projectId: lane.project.id, cells: lane.cells },
  ];
}

/** The row each shown card is in, by task id. */
export function rowIndex(lanes: ReadonlyArray<Lane>): Map<string, string> {
  const index = new Map<string, string>();
  for (const lane of lanes)
    for (const row of laneRows(lane))
      for (const status of STATUS_ORDER) for (const task of row.cells[status]) index.set(task.id, row.id);
  return index;
}

export function findRow(lanes: ReadonlyArray<Lane>, rowId: string): Row | null {
  for (const lane of lanes) for (const row of laneRows(lane)) if (row.id === rowId) return row;
  return null;
}

/** The lanes with one row's cells replaced; every other lane and band keeps its object. */
export function replaceRowCells(lanes: ReadonlyArray<Lane>, rowId: string, cells: LaneCells): ReadonlyArray<Lane> {
  return lanes.map((lane) => {
    if (lane.project.id === rowId) return { ...lane, cells };
    if (!lane.bands.some((band) => band.id === rowId)) return lane;
    return { ...lane, bands: lane.bands.map((band) => (band.id === rowId ? { ...band, cells } : band)) };
  });
}

/** The columns a band covers: from its first child's column to its last, or Backlog when it has none. */
export function bandSpan(cells: LaneCells): { start: number; end: number } {
  const filled = STATUS_ORDER.flatMap((status, index) => (cells[status].length > 0 ? [index] : []));
  return filled.length ? { start: filled[0]!, end: filled.at(-1)! } : { start: 0, end: 0 };
}

export interface VisibleCellTasks {
  visible: ReadonlyArray<TaskSummary>;
  /** Cards left out because the column is collapsed. */
  hiddenCount: number;
}

/**
 * The cards a cell renders. A collapsed column keeps the first few, plus any of `keepIds` that fall
 * past them (the selected card, the card being dragged) so those are never hidden.
 */
export function visibleCellTasks(
  tasks: ReadonlyArray<TaskSummary>,
  collapsed: boolean,
  keepIds: ReadonlyArray<string | null>,
): VisibleCellTasks {
  if (!collapsed || tasks.length <= COLUMN_PREVIEW_COUNT) return { visible: tasks, hiddenCount: 0 };
  const visible = tasks.slice(0, COLUMN_PREVIEW_COUNT);
  for (const task of tasks.slice(COLUMN_PREVIEW_COUNT)) if (keepIds.includes(task.id)) visible.push(task);
  return { visible, hiddenCount: tasks.length - visible.length };
}

/** True when any cell in the row is long enough to get a collapse toggle row. */
export function laneHasCollapsibleCell(cells: LaneCells): boolean {
  return STATUS_ORDER.some((status) => cells[status].length > COLUMN_PREVIEW_COUNT);
}

export interface BoardFilters {
  /** `?project=` id; unknown ids are ignored. */
  projectId: string | null;
  search: string;
  attentionOnly: boolean;
  /** Only cards with at least one PR link. */
  hasPrOnly: boolean;
  /** `?labels=`: only cards with any of these labels; empty shows all. */
  labels: ReadonlyArray<string>;
  /** `?epic=` id: only that epic's band; unknown ids are ignored. */
  epicId?: string | null;
  /** Only In Progress cards. */
  inProgressOnly?: boolean;
  /** Priority tasks gather in a lane above the projects instead of showing in their own. */
  priorityLane?: boolean;
}

function hasPr(task: TaskSummary): boolean {
  return task.links.some((link) => link.kind === "pr");
}

export function jiraKeys(task: TaskSummary): string[] {
  const keys: string[] = [];
  for (const link of task.links) if (link.kind === "jira") keys.push(link.ref.key);
  return keys;
}

/** Matches a card against the sidebar search: title, `#number` / bare number, Jira key or label. */
export function matchesTaskSearch(task: TaskSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  if (task.title.toLowerCase().includes(query)) return true;
  const numberQuery = query.startsWith("#") ? query.slice(1) : query;
  if (/^\d+$/.test(numberQuery) && String(task.number).startsWith(numberQuery)) return true;
  if (task.labels.some((label) => label.includes(query))) return true;
  return jiraKeys(task).some((key) => key.toLowerCase().includes(query));
}

function byPosition(a: TaskSummary, b: TaskSummary) {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

function byRecentStatusChange(a: TaskSummary, b: TaskSummary) {
  return a.statusChangedAt < b.statusChangedAt ? 1 : a.statusChangedAt > b.statusChangedAt ? -1 : 0;
}

function emptyCells(): Record<TaskStatus, TaskSummary[]> {
  return { backlog: [], planned: [], in_progress: [], review: [], done: [] };
}

function sortCells(cells: Record<TaskStatus, TaskSummary[]>): Record<TaskStatus, TaskSummary[]> {
  for (const status of STATUS_ORDER) cells[status].sort(status === "done" ? byRecentStatusChange : byPosition);
  return cells;
}

/**
 * Groups the board into one lane per project (in project order). Each epic gets a band holding its children
 * in five cells, and the other cards fill the lane's own five cells. A Done epic gets no band: it joins the
 * lane's Done cell as one card (newest-first by when it finished) and its children go in `epicChildren`.
 * Cells are ordered by position, except Done which is newest-first. With a text, attention, PR or label filter active, a band keeps the children
 * that match (all of them when the epic itself matches), and lanes without a match are dropped so results
 * are easy to scan. `archived` tasks (Show archived) join their lanes; the snapshot's copy wins if a task
 * is in both.
 *
 * With `priorityLane`, the board's open priority tasks (not archived, not epics, not Done) leave their projects for a lane in
 * front of them, whatever project is scoped to. The card filters still apply to them.
 */
export function buildLanes(
  board: BoardSnapshot,
  filters: BoardFilters,
  archived: ReadonlyArray<TaskSummary> = [],
): Lane[] {
  const scoped = filters.projectId && board.projects.some((p) => p.id === filters.projectId) ? filters.projectId : null;
  const active = new Set(board.tasks.map((task) => task.id));
  const tasks = archived.length ? [...board.tasks, ...archived.filter((task) => !active.has(task.id))] : board.tasks;
  const epicFilter =
    filters.epicId && tasks.some((t) => t.id === filters.epicId && t.kind === "epic") ? filters.epicId : null;
  const filtering =
    filters.search.trim() !== "" ||
    filters.attentionOnly ||
    filters.hasPrOnly ||
    filters.labels.length > 0 ||
    filters.inProgressOnly === true ||
    epicFilter !== null;
  const statusOk = (task: TaskSummary) => !filters.inProgressOnly || task.status === "in_progress";
  const inPriorityLane = (task: TaskSummary) =>
    filters.priorityLane === true &&
    task.priority &&
    task.kind !== "epic" &&
    !task.archivedAt &&
    // Finished work goes back to its project, so the lane only holds what is still open.
    task.status !== "done";
  const matches = (task: TaskSummary) =>
    (!filters.attentionOnly || task.attention.length > 0) &&
    (!filters.hasPrOnly || hasPr(task)) &&
    (!filters.labels.length || task.labels.some((label) => filters.labels.includes(label))) &&
    matchesTaskSearch(task, filters.search);

  const epics = new Map<string, TaskSummary>();
  for (const task of tasks) {
    if (task.kind !== "epic" || (scoped && task.projectId !== scoped)) continue;
    if (epicFilter && task.id !== epicFilter) continue;
    epics.set(task.id, task);
  }
  const bandCells = new Map<string, Record<TaskStatus, TaskSummary[]>>();
  const looseCells = new Map<string, Record<TaskStatus, TaskSummary[]>>();
  const allEpics = new Map(tasks.filter((t) => t.kind === "epic").map((t) => [t.id, t]));
  const priorityCells = emptyCells();
  let priorityCount = 0;
  const projectOrder = new Map(board.projects.map((p, index) => [p.id, index]));
  for (const task of tasks) {
    if (task.kind === "epic" || !statusOk(task)) continue;
    if (inPriorityLane(task)) {
      // An epic's filter and its card filters look at the epic the task is in, which may be in another project.
      const epic = task.parent ? allEpics.get(task.parent.id) : undefined;
      if (epicFilter && task.parent?.id !== epicFilter) continue;
      if (!matches(task) && !(epic && matches(epic))) continue;
      priorityCells[task.status].push(task);
      priorityCount++;
      continue;
    }
    if (scoped && task.projectId !== scoped) continue;
    const epic = task.parent ? epics.get(task.parent.id) : undefined;
    if (epicFilter && !epic) continue;
    if (!matches(task) && !(epic && matches(epic))) continue;
    const [target, key] = epic ? [bandCells, epic.id] : [looseCells, task.projectId];
    let cells = target.get(key);
    if (!cells) target.set(key, (cells = emptyCells()));
    cells[task.status].push(task);
  }

  const bandsByProject = new Map<string, EpicBand[]>();
  const childrenByProject = new Map<string, Record<string, ReadonlyArray<TaskSummary>>>();
  // By number: an epic's position belongs to its derived column and resets whenever that changes.
  for (const epic of [...epics.values()].sort((a, b) => a.number - b.number)) {
    const cells = bandCells.get(epic.id);
    // With no matching children, an epic shows only when it matches the filters itself (or is the one filtered to).
    if (!cells && filtering && epicFilter !== epic.id && !(epicFilter === null && matches(epic) && statusOk(epic)))
      continue;
    const resolved = sortCells(cells ?? emptyCells());
    // A finished epic would stack above everything in Done, so it is one card there instead. Filtered to
    // (`?epic=`), it keeps its band: the filter is for looking at its tasks.
    if (epic.status === "done" && epicFilter !== epic.id) {
      let loose = looseCells.get(epic.projectId);
      if (!loose) looseCells.set(epic.projectId, (loose = emptyCells()));
      loose.done.push(epic);
      const children = childrenByProject.get(epic.projectId) ?? {};
      children[epic.id] = STATUS_ORDER.flatMap((status) => resolved[status]);
      childrenByProject.set(epic.projectId, children);
      continue;
    }
    const bands = bandsByProject.get(epic.projectId) ?? [];
    bands.push({ id: epic.id, epic, cells: resolved, ...bandSpan(resolved) });
    bandsByProject.set(epic.projectId, bands);
  }

  const lanes: Lane[] = [];
  if (priorityCount > 0) {
    // Cards from different projects have no common order of their own: by project, then position.
    const rank = (task: TaskSummary) => projectOrder.get(task.projectId) ?? 0;
    for (const status of STATUS_ORDER) {
      const cells = priorityCells[status];
      cells.sort(status === "done" ? byRecentStatusChange : (a, b) => rank(a) - rank(b) || byPosition(a, b));
    }
    lanes.push({ priority: true, project: PRIORITY_PROJECT, bands: [], cells: priorityCells, epicChildren: {} });
  }
  for (const project of board.projects) {
    if (scoped && project.id !== scoped) continue;
    const cells = looseCells.get(project.id);
    const bands = bandsByProject.get(project.id) ?? [];
    if (!cells && bands.length === 0 && filtering) continue;
    lanes.push({
      project,
      bands,
      cells: sortCells(cells ?? emptyCells()),
      epicChildren: childrenByProject.get(project.id) ?? {},
    });
  }
  return lanes;
}

/** Cards per column across a lane's bands and loose cells. */
export function laneCounts(lane: Pick<Lane, "project" | "bands" | "cells">): Record<TaskStatus, number> {
  const counts = { backlog: 0, planned: 0, in_progress: 0, review: 0, done: 0 };
  for (const row of laneRows(lane)) for (const status of STATUS_ORDER) counts[status] += row.cells[status].length;
  return counts;
}

export function columnCounts(lanes: ReadonlyArray<Lane>): Record<TaskStatus, number> {
  const counts = { backlog: 0, planned: 0, in_progress: 0, review: 0, done: 0 };
  for (const lane of lanes) {
    const own = laneCounts(lane);
    for (const status of STATUS_ORDER) counts[status] += own[status];
  }
  return counts;
}

function sameItems<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function reuseChildren(old: Lane["epicChildren"], next: Lane["epicChildren"]): Lane["epicChildren"] {
  const ids = Object.keys(next);
  const merged = Object.fromEntries(
    ids.map((id) => [id, old[id] && sameItems(old[id], next[id]!) ? old[id] : next[id]!]),
  );
  return ids.length === Object.keys(old).length && ids.every((id) => merged[id] === old[id]) ? old : merged;
}

/** `old` when every cell holds the same cards, else `next` with its unchanged cells taken from `old`. */
function reuseCells(old: LaneCells, next: LaneCells): LaneCells {
  const cells: Record<TaskStatus, ReadonlyArray<TaskSummary>> = { ...next };
  let changed = false;
  for (const status of STATUS_ORDER) {
    if (sameItems(old[status], next[status])) cells[status] = old[status];
    else changed = true;
  }
  return changed ? cells : old;
}

/**
 * Reuses the previous lane, band, cell and array objects wherever their contents are unchanged, so
 * memoized lanes and cells skip re-rendering when an event touches some other part of the board.
 */
export function reuseUnchangedLanes(previous: ReadonlyArray<Lane>, next: Lane[]): Lane[] {
  const previousById = new Map(previous.map((lane) => [lane.project.id, lane]));
  return next.map((lane) => {
    const old = previousById.get(lane.project.id);
    if (!old) return lane;
    const cells = reuseCells(old.cells, lane.cells);
    const oldBands = new Map(old.bands.map((band) => [band.id, band]));
    const bands = lane.bands.map((band) => {
      const was = oldBands.get(band.id);
      if (!was) return band;
      const bandCells = reuseCells(was.cells, band.cells);
      const same =
        bandCells === was.cells && was.epic === band.epic && was.start === band.start && was.end === band.end;
      return same ? was : { ...band, cells: bandCells };
    });
    const sameBands = sameItems(old.bands, bands);
    const epicChildren = reuseChildren(old.epicChildren, lane.epicChildren);
    if (cells === old.cells && sameBands && epicChildren === old.epicChildren && old.project === lane.project) {
      return old;
    }
    return { ...lane, cells, bands: sameBands ? old.bands : bands, epicChildren };
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
  review_stalled: "Needs review",
  review_stuck: "Review stuck",
  review_failed: "Review failed",
  review_unattended: "Review findings",
  import_failed: "Import failed",
  autopilot: "Autopilot",
};

/** Tasks for the sidebar's "Needs attention" list: errors first, then most recently updated. */
export function attentionTasks(tasks: ReadonlyArray<TaskSummary>): TaskSummary[] {
  const rank = (task: TaskSummary) => (task.attention.some((r) => r.severity === "error") ? 0 : 1);
  return tasks
    .filter((task) => task.attention.length > 0)
    .sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Open (not Done) task counts per project, for the sidebar project list. Epics only group tasks, so they don't count. */
export function openTaskCounts(tasks: ReadonlyArray<TaskSummary>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks)
    if (task.status !== "done" && task.kind !== "epic")
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
  return counts;
}
