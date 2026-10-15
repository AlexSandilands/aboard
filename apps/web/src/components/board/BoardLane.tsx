import { TASK_STATUSES, type Project, type TaskStatus } from "@repo/contracts";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { memo } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { usePalette } from "~/state/ui";
import { laneHasCollapsibleCell, STATUS_ORDER, type LaneCells } from "./board.logic";
import { BoardCell } from "./BoardCell";

/**
 * Shared by the column header row and every lane so they stay aligned: columns share the width
 * evenly, and the board scrolls horizontally once they would drop below 240px.
 */
export const BOARD_GRID_CLASS_NAME =
  "grid grid-cols-[repeat(5,minmax(240px,1fr))] gap-3 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)";

/** A project swimlane: collapsible header, then one cell per status. */
export const BoardLane = memo(function BoardLane({
  project,
  cells,
  selectedTaskId,
  draggingTaskId,
  overStatus,
  overInvalid,
  onToggleCollapsed,
}: {
  project: Project;
  cells: LaneCells;
  selectedTaskId: string | null;
  /** The card being dragged, when it belongs to this lane. */
  draggingTaskId: string | null;
  /** The cell currently hovered by a dragged card, if it is in this lane. */
  overStatus: TaskStatus | null;
  overInvalid: boolean;
  onToggleCollapsed: (project: Project) => void;
}) {
  const collapsed = project.collapsed;
  const toggleRow = laneHasCollapsibleCell(cells);
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
              {cells[status].length}
            </span>
          ))}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Add idea to ${project.title}`}
                onClick={() => usePalette.getState().openPalette({ kind: "new-idea", projectId: project.id })}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup>Add idea</TooltipPopup>
        </Tooltip>
      </header>
      {collapsed ? null : (
        <div className={cn(BOARD_GRID_CLASS_NAME, "mt-1")}>
          {STATUS_ORDER.map((status) => (
            <BoardCell
              key={status}
              projectId={project.id}
              status={status}
              tasks={cells[status]}
              toggleRow={toggleRow}
              selectedTaskId={selectedTaskId}
              draggingTaskId={draggingTaskId}
              dropState={overStatus === status ? (overInvalid ? "invalid" : "valid") : null}
            />
          ))}
        </div>
      )}
    </section>
  );
});
