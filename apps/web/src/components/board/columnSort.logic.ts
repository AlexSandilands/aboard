import type { TaskStatus, TaskSummary } from "@repo/contracts";

/**
 * How a column orders its cards. `manual` is by position (the order cards were dragged into) and `finished` by when
 * they last changed column, newest first: Done's default, since Done has no hand-made order.
 */
export const COLUMN_SORTS = [
  "manual",
  "finished",
  "created_desc",
  "created_asc",
  "updated",
  "needs_plan",
  "number_desc",
  "number_asc",
  "due",
] as const;
export type ColumnSort = (typeof COLUMN_SORTS)[number];
export type ColumnSorts = Readonly<Partial<Record<TaskStatus, ColumnSort>>>;

export const COLUMN_SORT_LABELS: Record<ColumnSort, string> = {
  manual: "Manual",
  finished: "Recently finished",
  created_desc: "Newest created",
  created_asc: "Oldest created",
  updated: "Recently updated",
  needs_plan: "Needs a plan first",
  number_desc: "Number, high to low",
  number_asc: "Number, low to high",
  due: "Due date",
};

/** The sorts a column offers, in menu order: Done finishes cards rather than ordering them by hand, so it has no Manual. */
export function columnSortOptions(status: TaskStatus): ReadonlyArray<ColumnSort> {
  return COLUMN_SORTS.filter((sort) => (status === "done" ? sort !== "manual" : sort !== "finished"));
}

export function defaultColumnSort(status: TaskStatus): ColumnSort {
  return status === "done" ? "finished" : "manual";
}

export function isColumnSort(value: unknown): value is ColumnSort {
  return typeof value === "string" && (COLUMN_SORTS as ReadonlyArray<string>).includes(value);
}

/** The column's sort, falling back to its default when none is saved or the saved one isn't offered there. */
export function columnSortFor(sorts: ColumnSorts | undefined, status: TaskStatus): ColumnSort {
  const sort = sorts?.[status];
  return sort && columnSortOptions(status).includes(sort) ? sort : defaultColumnSort(status);
}

/** True when the column is in an order other than its default, which only dragging within the order can't keep. */
export function isSortedColumn(sorts: ColumnSorts | undefined, status: TaskStatus): boolean {
  return columnSortFor(sorts, status) !== defaultColumnSort(status);
}

type Compare = (a: TaskSummary, b: TaskSummary) => number;

const asc = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

export const byPosition: Compare = (a, b) => asc(a.position, b.position);
export const byRecentStatusChange: Compare = (a, b) => asc(b.statusChangedAt, a.statusChangedAt);
const byNewestCreated: Compare = (a, b) => asc(b.createdAt, a.createdAt);

/** A task that still needs a plan: no steps yet. Epics plan through their tasks and manual tasks need none. */
function needsPlan(task: TaskSummary): boolean {
  return task.kind !== "epic" && !task.manual && task.progress.total === 0;
}

const PRIMARY: Record<ColumnSort, Compare | null> = {
  manual: null,
  finished: byRecentStatusChange,
  created_desc: byNewestCreated,
  created_asc: (a, b) => asc(a.createdAt, b.createdAt),
  updated: (a, b) => asc(b.updatedAt, a.updatedAt),
  needs_plan: (a, b) => Number(needsPlan(b)) - Number(needsPlan(a)),
  number_desc: (a, b) => b.number - a.number,
  number_asc: (a, b) => a.number - b.number,
  // `YYYY-MM-DD` sorts as text; tasks with no date go last.
  due: (a, b) =>
    a.dueDate === b.dueDate ? 0 : a.dueDate === null ? 1 : b.dueDate === null ? -1 : asc(a.dueDate, b.dueDate),
};

/**
 * The comparator for a sort. Manual is by position alone and Recently finished by its time alone, as the board always
 * ordered them. Every other sort breaks ties by newest created, then by position, so equal cards keep a stable order.
 */
export function columnComparator(sort: ColumnSort): Compare {
  const primary = PRIMARY[sort];
  if (!primary) return byPosition;
  if (sort === "finished") return primary;
  return (a, b) => primary(a, b) || byNewestCreated(a, b) || byPosition(a, b);
}

/**
 * The priority lane's order for a sort: cards from different projects have no common order of their own, so they stay
 * grouped by project (`rank`, the project's place on the board), each project's cards in the column's sort.
 */
export function priorityLaneComparator(sort: ColumnSort, rank: (task: TaskSummary) => number): Compare {
  const compare = columnComparator(sort);
  return (a, b) => rank(a) - rank(b) || compare(a, b);
}
