import { describeEpicRollup } from "@repo/contracts";
import { ChevronRightIcon, GroupIcon } from "lucide-react";
import { memo, type CSSProperties } from "react";
import { AutopilotEpicButton } from "~/components/autopilot/AutopilotEpicButton";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useBoardView } from "~/state/ui";
import { laneHasCollapsibleCell, STATUS_ORDER, type EpicBand as Band } from "./board.logic";
import { BoardCell } from "./BoardCell";
import { useBoardContext } from "./BoardContext";
import type { OverCell } from "./dnd.logic";
import { EpicRollupBar } from "./EpicRollupBar";

/**
 * An epic's row in its lane: a header, then a cell for each column its children are in, laid on the lane's
 * own columns with a subgrid so the cards line up with the loose cards below. While one of its cards is
 * dragged it covers every column, so the card can be dropped in any of them.
 */
export const EpicBand = memo(function EpicBand({
  band,
  projectId,
  row,
  expanded,
  selectedTaskId,
  draggingTaskId,
  overCell,
}: {
  band: Band;
  projectId: string;
  /** Its grid row in the lane: bands stack, one epic per row. */
  row: number;
  /** Cover every column, for a drag starting inside the band. */
  expanded: boolean;
  selectedTaskId: string | null;
  draggingTaskId: string | null;
  overCell: OverCell | null;
}) {
  const { openTask } = useBoardContext();
  const collapsed = useBoardView((s) => !!s.collapsedEpics[band.id]) && !expanded;
  const toggleEpicCollapsed = useBoardView((s) => s.toggleEpicCollapsed);
  const { epic } = band;
  const rollup = epic.rollup ?? {
    total: 0,
    done: 0,
    byStatus: { backlog: 0, planned: 0, in_progress: 0, review: 0, done: 0 },
  };
  const [start, end] = expanded ? [0, STATUS_ORDER.length - 1] : [band.start, band.end];
  const style: CSSProperties = { gridRow: row, gridColumn: `${start + 1} / ${end + 2}` };
  const columns = STATUS_ORDER.slice(start, end + 1);
  const toggleRow = laneHasCollapsibleCell(band.cells);
  const selected = selectedTaskId === epic.id;
  // One column is too narrow for the title and the roll-up side by side.
  const narrow = columns.length === 1;

  return (
    <section
      aria-label={`Epic #${epic.number} ${epic.title}`}
      style={style}
      className={cn(
        "grid grid-cols-subgrid rounded-xl border border-border/60 bg-muted/25",
        selected && "border-primary/50 ring-1 ring-primary/30",
        epic.archivedAt && "opacity-60",
      )}
    >
      <header className={cn("col-span-full flex min-w-0 items-center gap-1.5 ps-1 pe-2", narrow ? "py-1" : "h-8")}>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          className={cn(narrow && "self-start")}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand epic #${epic.number}` : `Collapse epic #${epic.number}`}
          onClick={() => toggleEpicCollapsed(band.id)}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
        </Button>
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 gap-x-1.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
            narrow ? "flex-col gap-y-1" : "items-center",
          )}
          aria-current={selected || undefined}
          title={describeEpicRollup(rollup)}
          onClick={() => openTask(epic.id)}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <GroupIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{epic.number}</span>
            <span className="min-w-0 truncate text-sm font-medium text-foreground/90">{epic.title}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <EpicRollupBar rollup={rollup} className="w-16 shrink-0" />
            <span className="text-xs tabular-nums text-muted-foreground">
              {rollup.total === 0 ? "No tasks yet" : `${rollup.done}/${rollup.total} done`}
            </span>
          </span>
        </button>
        <AutopilotEpicButton epic={epic} className={cn(narrow && "self-start")} />
      </header>
      {collapsed
        ? null
        : columns.map((status) => (
            <BoardCell
              key={status}
              projectId={projectId}
              rowId={band.id}
              epicId={band.id}
              status={status}
              tasks={band.cells[status]}
              toggleRow={toggleRow}
              selectedTaskId={selectedTaskId}
              draggingTaskId={draggingTaskId}
              dropState={overCell?.status === status ? (overCell.invalid ? "invalid" : "valid") : null}
            />
          ))}
    </section>
  );
});
