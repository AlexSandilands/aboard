import { TASK_STATUSES } from "@repo/contracts";
import { PinIcon, StarIcon } from "lucide-react";
import { memo, type RefObject } from "react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { pinnedLaneMaxHeight } from "~/state/boardView.logic";
import { useBoardView } from "~/state/ui";
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
import { useStuck } from "./useStuck";

/**
 * The priority lane, above every project: the priority tasks of all of them in their usual columns. Its cards name
 * their project, change column by dragging, and leave the lane when dropped on their own project's lane.
 *
 * Pinned, it sticks under the column header as the board scrolls. Once scrolled it is stuck: its cards are one line
 * each and it takes no more than the chosen share of the window, scrolling inside itself past that.
 */
export const PriorityLane = memo(function PriorityLane({
  cells,
  selectedTaskId,
  draggingTaskId,
  overCell,
  columnHeaderRef,
}: {
  cells: LaneCells;
  selectedTaskId: string | null;
  /** The card being dragged, when it is in this lane. */
  draggingTaskId: string | null;
  /** The cell currently hovered by a dragged card, if it is in this lane. */
  overCell: OverCell | null;
  /** The sticky column header the pinned lane sits under. */
  columnHeaderRef: RefObject<HTMLElement | null>;
}) {
  const counts = laneCounts({ project: PRIORITY_PROJECT, bands: [], cells });
  const toggleRow = laneHasCollapsibleCell(cells);
  const pinned = useBoardView((s) => s.pinPriorityLane);
  const setPinned = useBoardView((s) => s.setPinPriorityLane);
  const maxHeight = useBoardView((s) => pinnedLaneMaxHeight(s.pinnedLaneHeight));
  const { sentinelRef, sectionRef, spacerRef, stuck } = useStuck(pinned, columnHeaderRef);
  const pinLabel = pinned ? "Unpin the priority lane" : "Pin the priority lane to the top of the board";
  return (
    <>
      {pinned ? <div ref={sentinelRef} aria-hidden className="pointer-events-none -mb-px h-px" /> : null}
      <section
        ref={sectionRef}
        id={`lane-${PRIORITY_ROW_ID}`}
        aria-label="Priority"
        data-pinned={pinned || undefined}
        data-stuck={stuck || undefined}
        style={stuck ? { maxHeight } : undefined}
        className={cn(
          "scroll-mt-10 border-b border-border/40 pt-1.5 pb-3",
          pinned
            ? // Under the column header (z-10) and the dependency lines (z-5), over the lanes. Opaque, so the cards
              // scrolling beneath don't show through the tint. `top` is the column header's height (h-9 and its
              // border, see Board.tsx); useStuck measures the same header for its observer.
              "sticky top-[calc(var(--spacing)*9+1px)] z-4 bg-background bg-linear-to-b from-warning/4 to-warning/4"
            : "bg-warning/4",
          stuck && "flex flex-col shadow-[0_10px_18px_-10px_rgb(0_0_0/0.35)]",
        )}
      >
        <header className="sticky left-0 flex h-8 w-fit max-w-dvw shrink-0 items-center gap-1.5 ps-[calc(var(--workspace-gutter-start)-0.25rem)] pe-2">
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  className={cn(pinned && "text-foreground")}
                  aria-label={pinLabel}
                  aria-pressed={pinned}
                  onClick={() => setPinned(!pinned)}
                />
              }
            >
              <PinIcon className={cn(pinned && "fill-current")} />
            </TooltipTrigger>
            <TooltipPopup>{pinLabel}</TooltipPopup>
          </Tooltip>
        </header>
        <div className={cn("mt-1", stuck && "min-h-0 flex-1 overflow-y-auto")}>
          <div className={BOARD_GRID_CLASS_NAME}>
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
                compact={stuck}
              />
            ))}
          </div>
        </div>
      </section>
      {pinned ? <div ref={spacerRef} aria-hidden className="pointer-events-none" /> : null}
    </>
  );
});
