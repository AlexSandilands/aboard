import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "@repo/contracts";

export interface EpicChildGroup {
  status: TaskStatus;
  tasks: ReadonlyArray<TaskSummary>;
}

/** An epic's children grouped by status in board order, empty groups left out. Archived children go last in their group. */
export function epicChildGroups(children: ReadonlyArray<TaskSummary>): EpicChildGroup[] {
  return TASK_STATUSES.flatMap(({ value }) => {
    const tasks = children
      .filter((c) => c.status === value)
      .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null));
    return tasks.length ? [{ status: value, tasks }] : [];
  });
}

/** Epics a task can join: open ones in its project, by number. None for an epic, since epics don't nest. */
export function epicOptions(
  tasks: ReadonlyArray<TaskSummary>,
  task: Pick<TaskSummary, "kind" | "projectId">,
): TaskSummary[] {
  if (task.kind === "epic") return [];
  return tasks
    .filter((t) => t.kind === "epic" && t.projectId === task.projectId && t.archivedAt === null)
    .sort((a, b) => a.number - b.number);
}

/** The "Show on board" button for an epic: its label, whether it's pressed, and the epic filter a click sets. */
export function showOnBoardToggle(
  epicId: string,
  activeFilter: string | null,
): { label: string; pressed: boolean; next: string | null } {
  const pressed = activeFilter === epicId;
  return { label: pressed ? "Showing on board" : "Show on board", pressed, next: pressed ? null : epicId };
}
