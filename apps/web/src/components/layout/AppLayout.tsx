import { useSearch } from "@tanstack/react-router";
import { memo, useEffect, useEffectEvent, useState } from "react";
import { Board } from "~/components/board/Board";
import { useCloseTask, useSelectedTaskId } from "~/components/board/boardNavigation";
import { TaskPanel } from "~/components/task/TaskPanel";
import { boardTransitionRunning } from "~/lib/boardMotion";
import { useMarkTaskNotificationsRead } from "~/state/mutations";
import { useSettingsNav } from "~/state/ui";
import { panelRestored } from "./panelRestore.logic";

/** The app loaded on the board itself (not on Settings or Stats), so its first board mount is a load, not a return. */
const loadedOnBoard = typeof window !== "undefined" && window.location.pathname === "/";
let boardMounted = false;

/**
 * Whether a closing panel stays mounted to slide out. Read from <html>, where the Appearance prefs and reduced motion
 * have already been resolved. Not in a board transition, whose View Transition animates the panel's snapshot instead.
 */
function panelSlidesOut(): boolean {
  return document.documentElement.dataset.panelAnimations === "true" && !boardTransitionRunning();
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
  // Decided on the first render only: a panel restored from Settings or on load appears in place, later opens slide.
  const [restored, setRestored] = useState(() => {
    const firstLoad = loadedOnBoard && !boardMounted;
    return panelRestored(taskId, useSettingsNav.getState().boardReturn.task, firstLoad);
  });
  const [closingId, setClosingId] = useState<string | null>(null);
  if (taskId !== shownId) {
    setShownId(taskId);
    setRestored(false);
    setClosingId(!taskId && shownId && panelSlidesOut() ? shownId : null);
  }
  const panelId = taskId ?? closingId;
  useEffect(() => {
    boardMounted = true;
  }, []);

  return (
    <>
      <MarkNotificationsRead taskId={taskId} />
      <MemoBoard />
      {panelId ? (
        <TaskPanel
          taskId={panelId}
          closing={!taskId}
          slideIn={!restored}
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
