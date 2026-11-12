import { useLayoutEffect, useMemo, useRef } from "react";
import { AppRouteModal, closeAppWindow } from "~/components/layout/AppRouteModal";
import { cardZoomTarget, panelZoomTarget, takeWindowSource, type WindowZoom } from "~/lib/windowZoom";
import { TaskPanelContent } from "./TaskPanel";

/** Set by `closeTaskWindow`, so the window's closing ends with the task closed rather than docked. */
let closesTask = false;

/**
 * Closes the open task from the task window, after the window has animated out: its Close button, a delete, and
 * `panel.toggle`. False when no window is open.
 */
export function closeTaskWindow(): boolean {
  closesTask = true;
  if (closeAppWindow()) return true;
  closesTask = false;
  return false;
}

/**
 * The open task in a large window over the board (`?expanded=true`), on the same shell as the Settings and Stats
 * windows. Its Dock button, Esc, a press on the backdrop and the `panel.expand` shortcut dock the task again once the
 * window has animated out (`onDocked`); its Close button closes the task. The docked panel stays behind it at its
 * width, with a placeholder (see `TaskPanel`).
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
    closesTask = false;
    return () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && contents?.contains(focused)) focused.blur();
    };
  }, []);
  const zoom = useMemo<WindowZoom>(
    () => ({
      enter: () => {
        const source = takeWindowSource(taskId);
        // A panel that went meanwhile leaves the card; no recorded source is a window restored, which fades.
        if (source === "panel") return panelZoomTarget() ?? cardZoomTarget(taskId);
        return source === "card" ? cardZoomTarget(taskId) : null;
      },
      exit: () => (closesTask ? cardZoomTarget(taskId) : panelZoomTarget()),
    }),
    [taskId],
  );
  return (
    <AppRouteModal
      label="Task details"
      zoom={zoom}
      onClosed={() => {
        const close = closesTask;
        closesTask = false;
        if (close) onClosedTask();
        else onDocked();
      }}
    >
      <div ref={contentsRef} className="@container flex min-h-0 flex-1 flex-col">
        <TaskPanelContent
          key={taskId}
          taskId={taskId}
          layout="window"
          onDock={() => closeAppWindow()}
          onClose={() => void closeTaskWindow()}
        />
      </div>
    </AppRouteModal>
  );
}
