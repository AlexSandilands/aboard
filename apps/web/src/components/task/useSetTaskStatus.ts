import type { TaskDetail, TaskStatus } from "@repo/contracts";

import { isPlanRequired, useMoveTask } from "~/state/mutations";

/**
 * Moves the task, opening the plan editor when the server says it needs a plan first. The fallback hangs off the
 * promise rather than a per-call `onError`: a card's menu unmounts when an item is picked, and TanStack Query drops
 * per-call callbacks once the component that made the call is gone.
 */
export function useSetTaskStatus(task: Pick<TaskDetail, "id" | "status">, onOpenPlanEditor: () => void) {
  const { mutateAsync: moveTask } = useMoveTask();
  return (status: TaskStatus) => {
    if (status === task.status) return;
    // Other failures are toasted (and the move rolled back) by useMoveTask itself.
    moveTask({ id: task.id, status }).catch((error: unknown) => {
      if (isPlanRequired(error)) onOpenPlanEditor();
    });
  };
}
