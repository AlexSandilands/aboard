import type { TaskDetail, TaskStatus } from "@repo/contracts";

import { isPlanRequired, useMoveTask } from "~/state/mutations";

/** Moves the task, opening the plan editor when the server says it needs a plan first. */
export function useSetTaskStatus(task: Pick<TaskDetail, "id" | "status">, onOpenPlanEditor: () => void) {
  const { mutate: moveTask } = useMoveTask();
  return (status: TaskStatus) => {
    if (status === task.status) return;
    moveTask({ id: task.id, status }, { onError: (error) => isPlanRequired(error) && onOpenPlanEditor() });
  };
}
