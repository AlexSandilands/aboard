import { TASK_STATUSES } from "@repo/contracts";
import { StarIcon } from "lucide-react";
import { memo } from "react";
import {
  laneCounts,
  laneHasCollapsibleCell,
  PRIORITY_PROJECT,
  PRIORITY_ROW_ID,
  STATUS_ORDER,
  type LaneCells,
} from "./board.logic";
import { BoardCell } from "./BoardCell";
import { BOARD_GRID_CLASS_NAME } from "./BoardLane";
import type { OverCell } from "./dnd.logic";

/**
 * The priority lane, above every project: the priority tasks of all of them in their usual columns. Its cards name
 * their project, change column by dragging, and leave the lane when dropped on their own project's lane.
 */
export const PriorityLane = memo(function PriorityLane({
  cells,
  selectedTaskId,
  draggingTaskId,
  overCell,
}: {
  cells: LaneCells;
  selectedTaskId: string | null;
  /** The card being dragged, when it is in this lane. */
  draggingTaskId: string | null;
  /** The cell currently hovered by a dragged card, if it is in this lane. */
  overCell: OverCell | null;
}) {
  const counts = laneCounts({ project: PRIORITY_PROJECT, bands: [], cells });
  const toggleRow = laneHasCollapsibleCell(cells);
  return (
    <section
      id={`lane-${PRIORITY_ROW_ID}`}
      aria-label="Priority"
      className="scroll-mt-10 border-b border-border/40 bg-warning/4 pt-1.5 pb-3"
    >
      <header className="sticky left-0 flex h-8 w-fit max-w-dvw items-center gap-1.5 ps-[calc(var(--workspace-gutter-start)-0.25rem)] pe-2">
        <StarIcon aria-hidden className="ms-1 me-0.5 size-4 fill-current text-warning" />
        <h2 className="text-sm font-medium text-foreground/90">Priority</h2>
        <span className="ms-1 flex items-center gap-1 text-2xs tabular-nums text-muted-foreground/70">
          {STATUS_ORDER.map((status, index) => (
            <span key={status} className="flex items-center gap-1" title={TASK_STATUSES[index]!.label}>
              {index > 0 ? <span aria-hidden>·</span> : null}
              {counts[status]}
            </span>
          ))}
        </span>
      </header>
      <div className={`${BOARD_GRID_CLASS_NAME} mt-1`}>
        {STATUS_ORDER.map((status) => (
          <BoardCell
            key={status}
            rowId={PRIORITY_ROW_ID}
            status={status}
            tasks={cells[status]}
            toggleRow={toggleRow}
            selectedTaskId={selectedTaskId}
            draggingTaskId={draggingTaskId}
            dropState={overCell?.status === status ? (overCell.invalid ? "invalid" : "valid") : null}
          />
        ))}
      </div>
    </section>
  );
});
