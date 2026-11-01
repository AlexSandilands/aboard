import { LABELS_PER_TASK_MAX, type TaskStatus, type TaskSummary } from "@repo/contracts";

// What the card menu's bulk actions do with several picked cards: which of them each action applies to, so items that
// apply to none are disabled and the summary toast can say how many were skipped.

/**
 * The picked cards that still exist, in number order. Deleted ones drop out of the pick's count. `tasks` may list a
 * task twice (the board snapshot and a stale archived cache); the first one wins.
 */
export function pickedTasks(picked: readonly string[], tasks: readonly TaskSummary[]): TaskSummary[] {
  const seen = new Set<string>();
  return tasks
    .filter((t) => picked.includes(t.id) && !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => a.number - b.number);
}

/** Whether the menu is the bulk one: the right-clicked card is one of two or more picked. */
export const isBulkMenu = (picked: readonly string[], taskId: string): boolean =>
  picked.length >= 2 && picked.includes(taskId);

/** An epic's status follows its tasks and an archived card can't be dragged, so neither moves or gets a priority. */
const isOpenTask = (t: TaskSummary): boolean => t.kind !== "epic" && t.archivedAt === null;

/** The server's plan gate: a task without a plan can only sit in Backlog (a manual task needs none). */
export const planGateRefuses = (t: TaskSummary, status: TaskStatus): boolean =>
  status !== "backlog" && !t.manual && t.progress.total === 0;

export interface BulkMove {
  /** Tasks to move. */
  move: TaskSummary[];
  /** Tasks the plan gate refuses; they stay where they are. */
  refused: TaskSummary[];
}

export function bulkMove(tasks: readonly TaskSummary[], status: TaskStatus): BulkMove {
  const movable = tasks.filter((t) => isOpenTask(t) && t.status !== status);
  return {
    move: movable.filter((t) => !planGateRefuses(t, status)),
    refused: movable.filter((t) => planGateRefuses(t, status)),
  };
}

/** Tasks whose priority differs from `on`. */
export const bulkPriority = (tasks: readonly TaskSummary[], on: boolean): TaskSummary[] =>
  tasks.filter((t) => isOpenTask(t) && t.priority !== on);

/** Tasks that can be closed as Won't do (epics can't be closed; one already Won't do stays so). */
export const bulkWontDo = (tasks: readonly TaskSummary[]): TaskSummary[] =>
  tasks.filter((t) => t.kind !== "epic" && t.resolution !== "wont_do");

/** Tasks that can be closed against another task. */
export const bulkCloseable = (tasks: readonly TaskSummary[]): TaskSummary[] => tasks.filter((t) => t.kind !== "epic");

/** Tasks to archive (`archived`) or unarchive. */
export const bulkArchive = (tasks: readonly TaskSummary[], archived: boolean): TaskSummary[] =>
  tasks.filter((t) => (t.archivedAt !== null) !== archived);

/** Tasks that take `label` (not carrying it, with room for one more) and tasks that lose it. */
export function bulkLabel(tasks: readonly TaskSummary[], label: string, mode: "add" | "remove"): TaskSummary[] {
  return mode === "add"
    ? tasks.filter((t) => !t.labels.includes(label) && t.labels.length < LABELS_PER_TASK_MAX)
    : tasks.filter((t) => t.labels.includes(label));
}

/** The labels worth offering: for adding, every label in use that some task lacks; for removing, those on a task. */
export function bulkLabelChoices(
  tasks: readonly TaskSummary[],
  inUse: ReadonlyArray<string>,
  mode: "add" | "remove",
): string[] {
  const names = mode === "add" ? inUse : [...new Set(tasks.flatMap((t) => t.labels))].sort();
  return names.filter((label) => bulkLabel(tasks, label, mode).length > 0);
}

/** `#14, #16, #26` */
export const referenceList = (tasks: readonly TaskSummary[]): string => tasks.map((t) => `#${t.number}`).join(", ");

/** "3 tasks": the menu's heading and the toast's count. */
export const taskCount = (n: number): string => `${n} task${n === 1 ? "" : "s"}`;

/**
 * The toast after a bulk action, e.g. "Moved 3 tasks to Review, 1 skipped (no plan), 1 failed". `done` words what was
 * done to the count; `skipped` are tasks the action didn't apply to (a plan gate refusal), `failed` ones the server
 * rejected.
 */
export function bulkSummary(
  done: (count: string) => string,
  counts: { ok: number; skipped?: number; failed?: number },
  skippedWhy = "",
): string {
  const parts = [done(taskCount(counts.ok))];
  if (counts.skipped) parts.push(`${counts.skipped} skipped${skippedWhy ? ` (${skippedWhy})` : ""}`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(", ");
}
