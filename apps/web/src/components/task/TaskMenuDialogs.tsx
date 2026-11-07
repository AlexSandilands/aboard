import { useState } from "react";

import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useDeleteTasks, useRestoreTasks } from "~/state/mutations";
import { useSettings, useTaskDetail } from "~/state/queries";
import { useDialogs, type DeletableTask } from "~/state/ui";
import { CloseTaskDialog } from "./CloseTaskDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { deleteConfirmText, deletedToastTitle, epicTasksLabel } from "./deleteTasks.logic";

/**
 * The dialogs a task's menu opens: the panel's More menu and the card context menu both close when an item is
 * picked, so the dialogs live here at the root instead of inside either menu.
 */
export function TaskMenuDialogs() {
  const closeTaskAs = useDialogs((s) => s.closeTaskAs);
  const deleting = useDialogs((s) => s.deleteTask);
  // Keep the last tasks while the confirmation animates out, so its title doesn't blank.
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
      <DeleteTasksDialog open={deleting !== null} tasks={shown?.tasks ?? []} onDeleted={shown?.onDeleted} />
    </>
  );
}

/** Confirms a delete into the trash, then offers Undo in the toast. */
function DeleteTasksDialog({
  open,
  tasks,
  onDeleted,
}: {
  open: boolean;
  tasks: DeletableTask[];
  onDeleted: (() => void) | undefined;
}) {
  const retentionDays = useSettings().data?.trashRetentionDays ?? 30;
  // An epic's detail lists all its tasks, archived ones too, which the delete takes with it.
  const epic = tasks.length === 1 && tasks[0]!.kind === "epic" ? tasks[0]! : null;
  const epicTasks = useTaskDetail(open ? epic?.id : null).data?.children.length ?? 0;
  const [withTasks, setWithTasks] = useState(false);
  // A new confirmation starts unticked, not with the last one's choice. Not a remount (a key): the toast's Undo and
  // the delete's onSuccess belong to this instance.
  const [openFor, setOpenFor] = useState(tasks);
  if (open && openFor !== tasks) {
    setOpenFor(tasks);
    setWithTasks(false);
  }
  const { mutate: restore } = useRestoreTasks();
  const { mutate: deleteTasks } = useDeleteTasks();
  const text = deleteConfirmText(tasks, retentionDays);
  const label = epicTasksLabel(tasks, epicTasks);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && useDialogs.getState().closeDeleteTask()}
      title={text.title}
      description={text.description}
      confirmLabel={text.confirmLabel}
      onConfirm={() => {
        if (tasks.length === 0) return;
        const picked = tasks;
        deleteTasks(
          { ids: picked.map((t) => t.id), withTasks: label !== null && withTasks },
          {
            onSuccess: ({ deleted }) =>
              toastManager.add({
                type: "success",
                title: deletedToastTitle(picked, deleted),
                actionProps: { children: "Undo", onClick: () => restore(deleted) },
              }),
          },
        );
        // Close up front: task.deleted can arrive before the response and flash "Task not found".
        // Failures still toast, since the hook's onError outlives the panel.
        onDeleted?.();
      }}
    >
      {label ? (
        <label className="flex items-center justify-between gap-3 text-sm">
          {label}
          <Switch checked={withTasks} onCheckedChange={setWithTasks} />
        </label>
      ) : null}
    </ConfirmDialog>
  );
}
