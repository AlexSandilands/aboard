import { useLocation, useSearch } from "@tanstack/react-router";
import { memo, useEffect, useEffectEvent, useState } from "react";
import { Board } from "~/components/board/Board";
import {
  useCloseTask,
  useSelectedTaskId,
  useSetTaskExpanded,
  useTaskExpanded,
} from "~/components/board/boardNavigation";
import { TaskPanel } from "~/components/task/TaskPanel";
import { TaskWindow } from "~/components/task/TaskWindow";
import { boardTransitionRunning } from "~/lib/boardMotion";
import { useMarkTaskNotificationsRead } from "~/state/mutations";
import { useSettingsNav } from "~/state/ui";

/** The app loaded on the board itself, so a panel on its first board mount is restored, not opened. */
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

/**
 * The board, and the `?task=` detail panel docked right, or the task window over the board with `?expanded=true`.
 * `AppFrame` renders it on "/" and keeps it mounted behind the Settings and Stats windows.
 */
export function AppLayout() {
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  const setExpanded = useSetTaskExpanded();
  // Behind the Settings or Stats window the task window steps aside, and comes back when that window closes: one
  // window at a time. Its contents go back to the docked panel meanwhile.
  const onBoard = useLocation({ select: (location) => location.pathname === "/" });
  const inWindow = useTaskExpanded() && taskId !== null && onBoard;
  // Remembered while on the board: behind a window the board keeps showing this view (`useBoardSearch`), closing the
  // window returns to it, and the project settings page starts on the scoped project. Read from the board route's
  // match, for its validated search; undefined off the board.
  const search = useSearch({ from: "/_app/", shouldThrow: false });
  useEffect(() => {
    if (search) useSettingsNav.getState().setBoardReturn(search);
  }, [search]);
  // With panel animations on, the panel stays mounted on the task it closed on until it has slid out.
  const [shownId, setShownId] = useState(taskId);
  // Decided on the first render only: a panel there when the app loads appears in place, later opens slide.
  const [restored, setRestored] = useState(() => taskId !== null && loadedOnBoard && !boardMounted);
  const [closingId, setClosingId] = useState<string | null>(null);
  // Whether the task last shown was in the window: a task closed from the window goes at once, with no placeholder
  // sliding out after it.
  const [shownInWindow, setShownInWindow] = useState(inWindow);
  if (taskId !== shownId) {
    setShownId(taskId);
    // A task opened straight into the window has its panel appear in place behind it: nothing slides under the window.
    setRestored(inWindow);
    setClosingId(!taskId && shownId && !shownInWindow && panelSlidesOut() ? shownId : null);
  }
  if (taskId && inWindow !== shownInWindow) setShownInWindow(inWindow);
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
          inWindow={inWindow}
          closing={!taskId}
          slideIn={!restored}
          onClose={() => void closeTask()}
          onClosed={() => setClosingId(null)}
        />
      ) : null}
      {taskId && inWindow ? (
        <TaskWindow taskId={taskId} onDocked={() => void setExpanded(false)} onClosedTask={() => void closeTask()} />
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
