import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
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

export type CellDropState = "valid" | "invalid" | null;

/** One project × status cell: a droppable column segment holding sortable cards. */
export const BoardCell = memo(function BoardCell({
  projectId,
  status,
  tasks,
  toggleRow,
  selectedTaskId,
  dropState,
}: {
  projectId: string;
  status: TaskStatus;
  tasks: ReadonlyArray<TaskSummary>;
  /** Some cell in this lane has a collapse toggle; the others keep a spacer so cards stay aligned. */
  toggleRow: boolean;
  selectedTaskId: string | null;
  dropState: CellDropState;
}) {
  const data: DragData = { type: "cell", projectId, status };
  const { setNodeRef } = useDroppable({ id: cellDroppableId(projectId, status), data });
  const collapsed = useBoardView((s) => isCellCollapsed(s, projectId, status));
  const toggleCellCollapsed = useBoardView((s) => s.toggleCellCollapsed);
  const { visible, hiddenCount } = useMemo(
    () => visibleCellTasks(tasks, collapsed, selectedTaskId),
    [tasks, collapsed, selectedTaskId],
  );
  const ids = useMemo(() => visible.map((task) => task.id), [visible]);

  return (
    <div
      ref={setNodeRef}
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
          onClick={() => toggleCellCollapsed(projectId, status)}
        >
          {collapsed ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
          {collapsed ? `Show all ${tasks.length}` : "Collapse"}
        </Button>
      ) : toggleRow ? (
        <div aria-hidden className="h-7 shrink-0 sm:h-6" />
      ) : null}
      <SortableContext id={cellKey(projectId, status)} items={ids} strategy={verticalListSortingStrategy}>
        {visible.map((task) => (
          <SortableTaskCard key={task.id} task={task} selected={task.id === selectedTaskId} />
        ))}
      </SortableContext>
      {status === "idea" && tasks.length === 0 ? (
        <Button
          variant="ghost-muted"
          size="xs"
          className="justify-start"
          onClick={() => usePalette.getState().openPalette({ kind: "new-idea", projectId })}
        >
          <PlusIcon />
          Add idea
        </Button>
      ) : null}
      {hiddenCount > 0 ? (
        <Button
          variant="ghost-muted"
          size="xs"
          className="justify-start"
          onClick={() => toggleCellCollapsed(projectId, status)}
        >
          Show {hiddenCount} more
        </Button>
      ) : null}
    </div>
  );
});
