import { describeEpicRollup } from "@repo/contracts";
import { ChevronRightIcon, GroupIcon } from "lucide-react";
import { memo, type CSSProperties } from "react";
import { AutopilotEpicButton } from "~/components/autopilot/AutopilotEpicButton";
import { EpicBranchBadge } from "~/components/task/EpicDelivery";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useBoardView } from "~/state/ui";
import { laneHasCollapsibleCell, STATUS_ORDER, type EpicBand as Band } from "./board.logic";
import { BoardCell } from "./BoardCell";
import { CardContextMenu } from "./CardContextMenu";
import { useBoardContext } from "./BoardContext";
import type { OverCell } from "./dnd.logic";
import { EpicActions } from "./EpicActions";
import { EpicRollupBar } from "./EpicRollupBar";
import { opensFromHeader, type HeaderClickTarget } from "./epicHeader.logic";
import {
  EPIC_ACCENT_BAR,
  EPIC_ACCENT_CLASS,
  EPIC_FRAME_CLASS,
  EPIC_HEADER_CLASS,
  epicAccentStyle,
} from "./epicStyle.logic";

const TITLE_BUTTON_CLASS =
  "flex h-6 min-w-0 items-center gap-1.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
  const style: CSSProperties = {
    gridRow: row,
    gridColumn: `${start + 1} / ${end + 2}`,
    ...(EPIC_ACCENT_BAR ? epicAccentStyle(epic.title) : {}),
  };
  const columns = STATUS_ORDER.slice(start, end + 1);
  const toggleRow = laneHasCollapsibleCell(band.cells);
  const selected = selectedTaskId === epic.id;
  // One column is too narrow for the title and the roll-up side by side: the header takes two rows.
  const narrow = columns.length === 1;
  const chevron = (
    <Button
      variant="ghost-muted"
      size="icon-xs"
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand epic #${epic.number}` : `Collapse epic #${epic.number}`}
      onClick={() => toggleEpicCollapsed(band.id)}
    >
      <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
    </Button>
  );
  const titleProps = { "aria-current": selected || undefined, onClick: () => openTask(epic.id) };
  const title = (
    <>
      <GroupIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{epic.number}</span>
      <span className="min-w-0 truncate text-sm font-medium text-foreground/90">{epic.title}</span>
    </>
  );
  // The narrow header drops "done" to leave room for the badge; the roll-up's tooltip says it in full.
  const count = (
    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
      {rollup.total === 0
        ? narrow
          ? "No tasks"
          : "No tasks yet"
        : `${rollup.done}/${rollup.total}${narrow ? "" : " done"}`}
    </span>
  );

  return (
    <section
      aria-label={`Epic #${epic.number} ${epic.title}`}
      data-vt-frame
      style={style}
      className={cn(
        "grid grid-cols-subgrid",
        EPIC_FRAME_CLASS,
        EPIC_ACCENT_BAR && EPIC_ACCENT_CLASS,
        selected && "border-primary/50 ring-1 ring-primary/30",
        epic.archivedAt && "opacity-60",
      )}
    >
      {/* The trigger draws no box, so the header stays a direct item of the band's grid. */}
      <CardContextMenu task={epic}>
        {/* The whole header opens the epic, for the pointer; the title button is the keyboard and screen reader way. */}
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a larger pointer target for the title button, which keyboards use */}
        <header
          // The marker the dependency lines look for: they end on the header, which stays when the band is collapsed.
          data-task-card={epic.id}
          data-vt-frame
          className={cn(
            "col-span-full flex min-w-0 cursor-pointer ps-1 pe-2",
            EPIC_HEADER_CLASS,
            collapsed && "rounded-b-xl",
            narrow ? "flex-col gap-0.5 py-1" : "h-8 items-center gap-1.5",
          )}
          onClick={(event) => {
            if (opensFromHeader(event.target as Partial<HeaderClickTarget> | null, event.currentTarget)) {
              openTask(epic.id);
            }
          }}
        >
          {narrow ? (
            <>
              <div data-vt-move className="flex h-6 min-w-0 items-center gap-1.5">
                {chevron}
                <button type="button" className={cn(TITLE_BUTTON_CLASS, "flex-1")} {...titleProps}>
                  {title}
                </button>
              </div>
              <div data-vt-move className="flex h-6 min-w-0 items-center gap-1.5 ps-7.5">
                {/* No min-w-0: the count always shows, and the bar gives way first when the badge needs the room. */}
                <span className="flex flex-1 items-center gap-1.5" title={describeEpicRollup(rollup)}>
                  <EpicRollupBar rollup={rollup} className="min-w-0 max-w-16 flex-1" />
                  {count}
                </span>
                <EpicBranchBadge epic={epic} compact />
                <EpicActions epic={epic} />
                <AutopilotEpicButton epic={epic} />
              </div>
            </>
          ) : (
            <>
              {chevron}
              <button
                type="button"
                className={cn(TITLE_BUTTON_CLASS, "flex-1 gap-x-3")}
                title={describeEpicRollup(rollup)}
                {...titleProps}
              >
                <span data-vt-move className="flex min-w-0 flex-1 items-center gap-1.5">
                  {title}
                </span>
                <span data-vt-move className="flex shrink-0 items-center gap-1.5">
                  <EpicRollupBar rollup={rollup} className="w-16 shrink-0" />
                  {count}
                </span>
              </button>
              <EpicBranchBadge epic={epic} />
              <EpicActions epic={epic} />
              <AutopilotEpicButton epic={epic} />
            </>
          )}
        </header>
      </CardContextMenu>
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
