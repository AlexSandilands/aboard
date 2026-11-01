import { useState } from "react";

import { useDeleteTask } from "~/state/mutations";
import { useDialogs } from "~/state/ui";
import { CloseTaskDialog } from "./CloseTaskDialog";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The dialogs a task's menu opens: the panel's More menu and the card context menu both close when an item is
 * picked, so the dialogs live here at the root instead of inside either menu.
 */
export function TaskMenuDialogs() {
  const closeTaskAs = useDialogs((s) => s.closeTaskAs);
  const deleting = useDialogs((s) => s.deleteTask);
  const { mutate: deleteTask } = useDeleteTask();
  // Keep the last task while the confirmation animates out, so its title doesn't blank.
  const [shown, setShown] = useState(deleting);
  if (deleting && deleting !== shown) setShown(deleting);
  const [shownClose, setShownClose] = useState(closeTaskAs);
  if (closeTaskAs && closeTaskAs !== shownClose) setShownClose(closeTaskAs);

  return (
    <>
      <CloseTaskDialog
        tasks={shownClose?.tasks ?? []}
        resolution={closeTaskAs?.resolution ?? null}
        onOpenChange={(open) => !open && useDialogs.getState().closeCloseTaskAs()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && useDialogs.getState().closeDeleteTask()}
        title={`Delete #${shown?.task.number ?? ""}?`}
        description="This permanently deletes the task with its plan, links and activity. It can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (!shown) return;
          // Close up front: task.deleted can arrive before the response and flash "Task not found".
          // Failures still toast, since the hook's onError outlives the panel.
          deleteTask(shown.task.id);
          shown.onDeleted?.();
        }}
      />
    </>
  );
}
