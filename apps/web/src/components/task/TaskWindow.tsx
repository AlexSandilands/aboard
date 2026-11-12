import { useLayoutEffect, useMemo, useRef } from "react";
import { AppRouteModal, closeAppWindow } from "~/components/layout/AppRouteModal";
import {
  cardZoomTarget,
  noteTaskDocked,
  panelZoomTarget,
  takeWindowSource,
  taskHomeIsPanel,
  type WindowZoom,
} from "~/lib/windowZoom";
import { TaskPanelContent } from "./TaskPanel";

/**
 * How the window is being left when that was said explicitly: `close` by `closeTaskWindow`, `dock` by
 * `dockTaskWindow`. Null (Esc, the backdrop) goes back where the task came from: the docked panel, or the board.
 */
let leaving: "close" | "dock" | null = null;

/**
 * Closes the open task from the task window, after the window has animated out: its Close button, a delete, and
 * `panel.toggle`. False when no window is open.
 */
export function closeTaskWindow(): boolean {
  leaving = "close";
  if (closeAppWindow()) return true;
  leaving = null;
  return false;
}

/** Docks the open task from the task window, after the window has animated out: its Dock button and `panel.expand`. */
export function dockTaskWindow(): boolean {
  leaving = "dock";
  if (closeAppWindow()) return true;
  leaving = null;
  return false;
}

/** Whether leaving the window now closes the task rather than docking it. */
const leaveCloses = (taskId: string) => (leaving ? leaving === "close" : !taskHomeIsPanel(taskId));

/**
 * The open task in a large window over the board (`?expanded=true`), on the same shell as the Settings and Stats
 * windows. Its Dock button and the `panel.expand` shortcut dock the task again once the window has animated out
 * (`onDocked`); its Close button closes the task. Esc and a press on the backdrop go back where the task came from:
 * docked when a panel was open as it was opened, otherwise closed onto its card (`taskHomeIsPanel`). The docked panel
 * stays behind the window at its width, with a placeholder (see `TaskPanel`), unless the task came from the board.
 *
 * The window grows out of where it was opened from, the docked panel or the task's card (recorded by the way in:
 * `noteWindowSource`), and shrinks into the panel when it docks or onto the card when the task closes
 * (`lib/windowZoom.ts`). Restored rather than opened (on load, from behind Settings), or with the card off screen, it
 * fades.
 */
export function TaskWindow({
  taskId,
  onDocked,
  onClosedTask,
}: {
  taskId: string;
  onDocked: () => void;
  onClosedTask: () => void;
}) {
  const contentsRef = useRef<HTMLDivElement>(null);
  // Unmounted without closing (the browser's Back, `j`, Settings opening), the window drops a focused field without a
  // blur, and commit-on-blur editors would lose what was typed: blur it while it is still in the page.
  useLayoutEffect(() => {
    const contents = contentsRef.current;
    leaving = null;
    return () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && contents?.contains(focused)) focused.blur();
    };
  }, []);
  const zoom = useMemo<WindowZoom>(
    () => ({
      // No recorded source is a window restored, which fades.
      enter: () => takeWindowSource(taskId),
      exit: () => (leaveCloses(taskId) ? cardZoomTarget(taskId) : panelZoomTarget()),
    }),
    [taskId],
  );
  return (
    <AppRouteModal
      label="Task details"
      zoom={zoom}
      onClosed={() => {
        const close = leaveCloses(taskId);
        leaving = null;
        if (close) onClosedTask();
        else {
          noteTaskDocked(taskId);
          onDocked();
        }
      }}
    >
      <div ref={contentsRef} data-task-window="" className="@container flex min-h-0 flex-1 flex-col">
        <TaskPanelContent
          key={taskId}
          taskId={taskId}
          layout="window"
          onDock={() => void dockTaskWindow()}
          onClose={() => void closeTaskWindow()}
        />
      </div>
    </AppRouteModal>
  );
}
