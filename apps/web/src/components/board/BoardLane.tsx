import { TASK_STATUSES, type Project } from "@repo/contracts";
import { ChevronRightIcon, GroupIcon, PlusIcon } from "lucide-react";
import { memo } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { usePalette } from "~/state/ui";
import { laneCounts, laneHasCollapsibleCell, STATUS_ORDER, type EpicBand as Band, type LaneCells } from "./board.logic";
import { BoardCell } from "./BoardCell";
import type { OverCell } from "./dnd.logic";
import { EpicBand } from "./EpicBand";

/**
 * Shared by the column header row and every lane so they stay aligned: columns share the width
 * evenly, and the board scrolls horizontally once they would drop below 240px.
 */
export const BOARD_GRID_CLASS_NAME =
  "grid grid-cols-[repeat(5,minmax(240px,1fr))] gap-3 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)";

/** A project swimlane: collapsible header, its epic bands, then one cell per status for the other cards. */
export const BoardLane = memo(function BoardLane({
  project,
  bands,
  cells,
  selectedTaskId,
  draggingTaskId,
  draggingRowId,
  overCell,
  onToggleCollapsed,
}: {
  project: Project;
  bands: ReadonlyArray<Band>;
  cells: LaneCells;
  selectedTaskId: string | null;
  /** The card being dragged, when it belongs to this lane. */
  draggingTaskId: string | null;
  /** The row of the card being dragged, when it belongs to this lane: its band covers every column. */
  draggingRowId: string | null;
  /** The cell currently hovered by a dragged card, if it is in this lane. */
  overCell: OverCell | null;
  onToggleCollapsed: (project: Project) => void;
}) {
  const collapsed = project.collapsed;
  const toggleRow = laneHasCollapsibleCell(cells);
  const counts = laneCounts({ project, bands, cells });
  const overLoose = overCell?.rowId === project.id ? overCell : null;
  return (
    <section
      id={`lane-${project.id}`}
      aria-label={project.title}
      className="scroll-mt-10 border-b border-border/40 pt-1.5 pb-3"
    >
      <header className="sticky left-0 flex h-8 w-fit max-w-dvw items-center gap-1.5 ps-[calc(var(--workspace-gutter-start)-0.25rem)] pe-2">
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${project.title}` : `Collapse ${project.title}`}
          onClick={() => onToggleCollapsed(project)}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
        </Button>
        <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />
        <h2 className="max-w-80 truncate text-sm font-medium text-foreground/90">{project.title}</h2>
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
                aria-label={`Add task to ${project.title}`}
                onClick={() => usePalette.getState().openPalette({ kind: "new-task", projectId: project.id })}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup>Add task</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Add epic to ${project.title}`}
                onClick={() => usePalette.getState().openPalette({ kind: "new-epic", projectId: project.id })}
              />
            }
          >
            <GroupIcon />
          </TooltipTrigger>
          <TooltipPopup>Add epic</TooltipPopup>
        </Tooltip>
      </header>
      {collapsed ? null : (
        <div className={cn(BOARD_GRID_CLASS_NAME, "mt-1")}>
          {bands.map((band, index) => (
            <EpicBand
              key={band.id}
              band={band}
              projectId={project.id}
              row={index + 1}
              expanded={draggingRowId === band.id}
              selectedTaskId={selectedTaskId}
              draggingTaskId={draggingRowId === band.id ? draggingTaskId : null}
              overCell={overCell?.rowId === band.id ? overCell : null}
            />
          ))}
          {/* Under bands, an empty loose row would only add a stray Add task; the header's + covers it. */}
          {bands.length > 0 && STATUS_ORDER.every((status) => cells[status].length === 0) && !overLoose
            ? null
            : STATUS_ORDER.map((status) => (
                <BoardCell
                  key={status}
                  projectId={project.id}
                  rowId={project.id}
                  gridRow={bands.length ? bands.length + 1 : undefined}
                  status={status}
                  tasks={cells[status]}
                  toggleRow={toggleRow}
                  selectedTaskId={selectedTaskId}
                  draggingTaskId={draggingTaskId}
                  dropState={overLoose?.status === status ? (overLoose.invalid ? "invalid" : "valid") : null}
                />
              ))}
        </div>
      )}
    </section>
  );
});
