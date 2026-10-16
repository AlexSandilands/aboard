import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import type { TaskStatus, TaskSummary } from "@repo/contracts";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { Button } from "~/components/ui/button";
import { useBoardView, usePalette } from "~/state/ui";
import { cn } from "~/lib/utils";
import { COLUMN_PREVIEW_COUNT, visibleCellTasks } from "./board.logic";
import { isCellCollapsed } from "./columnCollapse.logic";
import { cellDroppableId, cellKey, type DragData } from "./dnd.logic";
import { SortableTaskCard } from "./TaskCard";

// Done is newest-first whatever the drag, so its cards don't shuffle to make room.
const noSorting: SortingStrategy = () => null;

export type CellDropState = "valid" | "invalid" | null;

/** One row × status cell (a project's loose cards or an epic band): a droppable column segment holding sortable cards. */
export const BoardCell = memo(function BoardCell({
  projectId,
  rowId,
  epicId,
  status,
  gridRow,
  tasks,
  toggleRow,
  selectedTaskId,
  draggingTaskId,
  dropState,
}: {
  projectId: string;
  /** The project id for loose cards, the epic id in a band. */
  rowId: string;
  /** Set in an epic band: Add task puts new tasks in the epic. */
  epicId?: string;
  status: TaskStatus;
  /** Grid row, for the loose cells under a lane's epic bands. */
  gridRow?: number;
  tasks: ReadonlyArray<TaskSummary>;
  /** Some cell in this lane has a collapse toggle; the others keep a spacer so cards stay aligned. */
  toggleRow: boolean;
  selectedTaskId: string | null;
  /** The card being dragged, when it belongs to this lane; a collapsed cell keeps it in view. */
  draggingTaskId: string | null;
  dropState: CellDropState;
}) {
  const data: DragData = { type: "cell", rowId, status };
  const { setNodeRef } = useDroppable({ id: cellDroppableId(rowId, status), data });
  const collapsed = useBoardView((s) => isCellCollapsed(s, rowId, status));
  const toggleCellCollapsed = useBoardView((s) => s.toggleCellCollapsed);
  const { visible, hiddenCount } = useMemo(
    () => visibleCellTasks(tasks, collapsed, [selectedTaskId, draggingTaskId]),
    [tasks, collapsed, selectedTaskId, draggingTaskId],
  );
  const ids = useMemo(() => visible.map((task) => task.id), [visible]);

  return (
    <div
      ref={setNodeRef}
      style={gridRow ? { gridRow } : undefined}
      data-drop-state={dropState ?? undefined}
      className={cn(
        "flex min-h-14 min-w-0 flex-col gap-1.5 rounded-xl p-1",
        dropState === "valid" && "bg-accent/30 ring-1 ring-inset ring-primary/30",
        dropState === "invalid" && "cursor-not-allowed bg-error/5 ring-1 ring-inset ring-error/40",
      )}
    >
      {tasks.length > COLUMN_PREVIEW_COUNT ? (
        <Button
          variant="ghost-muted"
          size="xs"
          className="justify-start"
          aria-expanded={!collapsed}
          onClick={() => toggleCellCollapsed(rowId, status)}
        >
          {collapsed ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
          {collapsed ? `Show all ${tasks.length}` : "Collapse"}
        </Button>
      ) : toggleRow ? (
        <div aria-hidden className="h-7 shrink-0 sm:h-6" />
      ) : null}
      <SortableContext
        id={cellKey(rowId, status)}
        items={ids}
        strategy={status === "done" ? noSorting : verticalListSortingStrategy}
      >
        {visible.map((task) => (
          <SortableTaskCard key={task.id} task={task} rowId={rowId} selected={task.id === selectedTaskId} />
        ))}
      </SortableContext>
      {status === "backlog" && tasks.length === 0 ? (
        <Button
          variant="ghost-muted"
          size="xs"
          className="justify-start"
          onClick={() => usePalette.getState().openPalette({ kind: "new-task", projectId, epicId })}
        >
          <PlusIcon />
          Add task
        </Button>
      ) : null}
      {hiddenCount > 0 ? (
        <Button
          variant="ghost-muted"
          size="xs"
          className="justify-start"
          onClick={() => toggleCellCollapsed(rowId, status)}
        >
          Show {hiddenCount} more
        </Button>
      ) : null}
    </div>
  );
});
