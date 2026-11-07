import type { DeletableTask } from "~/state/ui";

/** The confirmation's wording for deleting `tasks` into a trash that keeps them `retentionDays` days. */
export function deleteConfirmText(
  tasks: ReadonlyArray<DeletableTask>,
  retentionDays: number,
): { title: string; description: string; confirmLabel: string } {
  const one = tasks.length === 1 ? tasks[0]! : null;
  const days = `${retentionDays} day${retentionDays === 1 ? "" : "s"}`;
  return {
    title: one ? `Delete #${one.number}?` : `Delete ${tasks.length} tasks?`,
    description: one
      ? one.kind === "epic"
        ? `"${one.title}" goes to the trash with its links and activity; its tasks stay on the board unless they go with it. You can restore it from Settings → Recently deleted for ${days}.`
        : `"${one.title}" goes to the trash with its plan, links and activity. You can restore it from Settings → Recently deleted for ${days}.`
      : `They go to the trash with their plans, links and activity. You can restore them from Settings → Recently deleted for ${days}.`,
    confirmLabel: one ? "Delete" : `Delete ${tasks.length} tasks`,
  };
}

/** The checkbox label for deleting an epic's `count` tasks with it, or null when there is nothing to ask. */
export function epicTasksLabel(tasks: ReadonlyArray<DeletableTask>, count: number): string | null {
  if (tasks.length !== 1 || tasks[0]!.kind !== "epic" || count === 0) return null;
  return count === 1 ? "Also delete its task" : `Also delete its ${count} tasks`;
}

/** The toast after a delete went through: what went, by number when it was one task. */
export function deletedToastTitle(tasks: ReadonlyArray<DeletableTask>, deleted: ReadonlyArray<string>): string {
  const one = tasks.length === 1 ? tasks[0]! : null;
  if (one && deleted.length <= 1) return `Deleted #${one.number}`;
  if (one) return `Deleted #${one.number} and its ${deleted.length - 1} task${deleted.length === 2 ? "" : "s"}`;
  return `Deleted ${deleted.length} tasks`;
}
