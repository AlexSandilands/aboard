import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { TaskStatus, TaskSummary } from "@taskboard/contracts";
import { PlusIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { Button } from "~/components/ui/button";
import { usePalette } from "~/state/ui";
import { cn } from "~/lib/utils";
import { DONE_PREVIEW_COUNT } from "./board.logic";
import { cellDroppableId, cellKey, type DragData } from "./dnd.logic";
import { SortableTaskCard } from "./TaskCard";

export type CellDropState = "valid" | "invalid" | null;

/** One project × status cell: a droppable column segment holding sortable cards. */
export const BoardCell = memo(function BoardCell({
  projectId,
  status,
  tasks,
  selectedTaskId,
  dropState,
  doneExpanded,
  onToggleDone,
}: {
  projectId: string;
  status: TaskStatus;
  tasks: ReadonlyArray<TaskSummary>;
  selectedTaskId: string | null;
  dropState: CellDropState;
  doneExpanded: boolean;
  onToggleDone: (projectId: string) => void;
}) {
  const data: DragData = { type: "cell", projectId, status };
  const { setNodeRef } = useDroppable({ id: cellDroppableId(projectId, status), data });
  const truncated = status === "done" && !doneExpanded && tasks.length > DONE_PREVIEW_COUNT;
  const visible = truncated ? tasks.slice(0, DONE_PREVIEW_COUNT) : tasks;
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
      {status === "done" && tasks.length > DONE_PREVIEW_COUNT ? (
        <Button variant="ghost-muted" size="xs" className="justify-start" onClick={() => onToggleDone(projectId)}>
          {doneExpanded ? "Show less" : `Show ${tasks.length - DONE_PREVIEW_COUNT} more`}
        </Button>
      ) : null}
    </div>
  );
});
