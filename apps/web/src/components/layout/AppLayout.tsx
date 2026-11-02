import { useSearch } from "@tanstack/react-router";
import { memo, useEffect, useEffectEvent, useState } from "react";
import { Board } from "~/components/board/Board";
import { useCloseTask, useSelectedTaskId } from "~/components/board/boardNavigation";
import { TaskPanel } from "~/components/task/TaskPanel";
import { useMarkTaskNotificationsRead } from "~/state/mutations";
import { useSettingsNav } from "~/state/ui";

/** Read from <html>, where the Appearance prefs and reduced motion have already been resolved. */
function panelAnimationsOn(): boolean {
  return document.documentElement.dataset.panelAnimations === "true";
}

/**
 * The board renders hundreds of components, so it doesn't follow this layout's re-renders (the panel opening or
 * closing): those would land in the panel's slide. It has no props, and its own hooks pick up what it shows.
 */
const MemoBoard = memo(Board);

/** Route component for "/": the board, and the `?task=` detail panel docked right. */
export function AppLayout() {
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  // Remembered so Settings' Back returns to this view, and its project page starts on the scoped project.
  const search = useSearch({ from: "/_app/" });
  useEffect(() => useSettingsNav.getState().setBoardReturn(search), [search]);
  // With panel animations on, the panel stays mounted on the task it closed on until it has slid out.
  const [shownId, setShownId] = useState(taskId);
  const [closingId, setClosingId] = useState<string | null>(null);
  if (taskId !== shownId) {
    setShownId(taskId);
    setClosingId(!taskId && shownId && panelAnimationsOn() ? shownId : null);
  }
  const panelId = taskId ?? closingId;

  return (
    <>
      <MarkNotificationsRead taskId={taskId} />
      <MemoBoard />
      {panelId ? (
        <TaskPanel
          taskId={panelId}
          closing={!taskId}
          onClose={() => void closeTask()}
          onClosed={() => setClosingId(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Opening a task, by any route, answers its notifications. Only when it opens: a task that merely shows on the board
 * doesn't. A component of its own because the mutation re-renders whoever holds it, twice per task opened.
 */
function MarkNotificationsRead({ taskId }: { taskId: string | null }) {
  const markTaskRead = useMarkTaskNotificationsRead();
  const clearNotifications = useEffectEvent((id: string) => markTaskRead.mutate(id));
  useEffect(() => {
    if (taskId) clearNotifications(taskId);
  }, [taskId]);
  return null;
}
