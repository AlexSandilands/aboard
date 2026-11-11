import { useRef } from "react";
import { AppRouteModal, closeAppWindow } from "~/components/layout/AppRouteModal";
import { TaskPanelContent } from "./TaskPanel";

/**
 * The open task in a large window over the board (`?expanded=true`), on the same shell as the Settings and Stats
 * windows. Its Dock button, Esc, a press on the backdrop and the `panel.expand` shortcut dock the task again once the
 * window has animated out (`onDocked`); its Close button closes the task. The docked panel stays behind it at its
 * width, with a placeholder (see `TaskPanel`).
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
  // Set by Close (and a delete) so the window's closing ends with the task closed rather than docked.
  const closesTask = useRef(false);
  return (
    <AppRouteModal label="Task details" onClosed={() => (closesTask.current ? onClosedTask() : onDocked())}>
      <div className="@container flex min-h-0 flex-1 flex-col">
        <TaskPanelContent
          key={taskId}
          taskId={taskId}
          layout="window"
          onDock={() => closeAppWindow()}
          onClose={() => {
            closesTask.current = true;
            closeAppWindow();
          }}
        />
      </div>
    </AppRouteModal>
  );
}
