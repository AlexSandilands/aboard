import { TASK_STATUSES, type TaskSummary } from "@repo/contracts";
import { CheckIcon, MoveRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { TaskMenuItems } from "~/components/task/TaskMenuItems";
import { useSetTaskStatus } from "~/components/task/useSetTaskStatus";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "~/components/ui/context-menu";
import { MenuItem, MenuItemLabel, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { useArchivedTasks, useBoard } from "~/state/queries";
import { useBoardPick } from "~/state/ui";
import { useBoardContext } from "./BoardContext";
import { useCloseTask, useSelectedTaskId } from "./boardNavigation";
import { BulkMenuItems } from "./BulkMenuItems";
import { isBulkMenu, pickedTasks } from "./bulkMenu.logic";

/**
 * Right-click, the Menu key or Shift+F10 on a card opens its menu: Move to, then the panel's More menu.
 * The trigger draws no box of its own (`contents`), so the card's layout and drag handling stay as they were; the
 * popup mounts only while open, so a board of cards carries one menu's worth of hooks, not hundreds.
 */
export function CardContextMenu({ task, children }: { task: TaskSummary; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuPopup>
        <CardMenuItems task={task} />
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/** The bulk menu when the card is one of two or more picked, else the card's own. The pick is read as the menu opens. */
function CardMenuItems({ task }: { task: TaskSummary }) {
  const picked = useBoardPick((s) => s.picked);
  const boardTasks = useBoard().data?.tasks;
  // Archived cards (Show archived) aren't in the board snapshot; their query is already cached while they are shown.
  const archivedTasks = useArchivedTasks(false).data;
  const bulk = isBulkMenu(picked, task.id)
    ? pickedTasks(picked, [...(boardTasks ?? []), ...(archivedTasks ?? [])])
    : [];
  return bulk.length >= 2 ? <BulkMenuItems tasks={bulk} /> : <SingleMenuItems task={task} />;
}

function SingleMenuItems({ task }: { task: TaskSummary }) {
  const { openPlanEditor, projects } = useBoardContext();
  const closeTask = useCloseTask();
  const selectedTaskId = useSelectedTaskId();
  const setStatus = useSetTaskStatus(task, () => openPlanEditor(task.id));
  return (
    <TaskMenuItems
      task={task}
      projects={projects}
      onOpenPlanEditor={() => openPlanEditor(task.id)}
      // The card is already in view, so Jump to card has nothing to do here.
      omit={["jump"]}
      // Deleting the task whose panel is open closes the panel, like deleting from the panel does.
      onDeleted={task.id === selectedTaskId ? () => void closeTask() : undefined}
      leading={
        // An epic's status follows its tasks, so there is nothing to move.
        task.kind === "epic" ? null : (
          <>
            <MenuSub>
              <MenuSubTrigger>
                <MoveRightIcon />
                Move to
              </MenuSubTrigger>
              <MenuSubPopup>
                {TASK_STATUSES.map((status) => (
                  <MenuItem
                    key={status.value}
                    disabled={status.value === task.status}
                    onClick={() => setStatus(status.value)}
                  >
                    <MenuItemLabel>{status.label}</MenuItemLabel>
                    {status.value === task.status ? <CheckIcon className="ms-auto size-3.5" /> : null}
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
            <MenuSeparator />
          </>
        )
      }
    />
  );
}
