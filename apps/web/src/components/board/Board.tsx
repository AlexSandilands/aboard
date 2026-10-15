import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { TASK_STATUSES, type BoardSnapshot, type Project, type TaskStatus } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, LayoutGridIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { isPlanRequired, useMoveTask, useUpdateProject } from "~/state/mutations";
import { queryKeys, useArchivedTasks, useBoard, useSettings } from "~/state/queries";
import { useBoardView, usePalette, usePanel } from "~/state/ui";
import {
  buildLanes,
  COLUMN_PREVIEW_COUNT,
  columnCounts,
  reuseUnchangedLanes,
  STATUS_ORDER,
  visibleCellTasks,
} from "./board.logic";
import { isCellCollapsed, isColumnMixed } from "./columnCollapse.logic";
import { BoardContext, type BoardContextValue } from "./BoardContext";
import { BoardHeader } from "./BoardHeader";
import { BOARD_GRID_CLASS_NAME, BoardLane } from "./BoardLane";
import { useOpenTask, useProjectFilter, useSelectedTaskId } from "./boardNavigation";
import { computeDrop, landsPastPreview, readDragData } from "./dnd.logic";
import { TaskCardOverlay } from "./TaskCard";

const STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<TaskStatus, string>;

/** Pointer hits prefer cards over the cell beneath them; keyboard drags fall back to corners. */
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length > 0) {
    const cards = hits.filter((hit) => !String(hit.id).startsWith("cell:"));
    return cards.length > 0 ? cards : hits;
  }
  return closestCorners(args);
};

/** The main board: header, sticky column headers and one swimlane per project. */
export function Board() {
  const boardQuery = useBoard();
  const projectFilter = useProjectFilter();
  const scopedProject = boardQuery.data?.projects.find((p) => p.id === projectFilter) ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BoardHeader scopedProject={scopedProject} />
      {boardQuery.data ? (
        <BoardContent board={boardQuery.data} projectFilter={scopedProject?.id ?? null} />
      ) : boardQuery.isError ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGridIcon />
            </EmptyMedia>
            <EmptyTitle>Couldn't load the board</EmptyTitle>
            <EmptyDescription>{boardQuery.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => void boardQuery.refetch()}>
              <RefreshCwIcon />
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <BoardSkeleton />
      )}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div aria-busy className="min-h-0 flex-1 overflow-hidden">
      <div className={cn(BOARD_GRID_CLASS_NAME, "h-9 items-center border-b border-border/65")}>
        {STATUS_ORDER.map((status) => (
          <Skeleton key={status} className="h-3 w-20" />
        ))}
      </div>
      {[0, 1].map((lane) => (
        <div key={lane} className="pt-3 pb-4">
          <Skeleton className="ms-(--workspace-gutter-start) mb-3 h-4 w-40" />
          <div className={BOARD_GRID_CLASS_NAME}>
            {STATUS_ORDER.map((status, index) => (
              <div key={status} className="flex flex-col gap-1.5 p-1">
                {Array.from({ length: (lane + index) % 3 }, (_, card) => (
                  <Skeleton key={card} shape="card" className="h-20 w-full" />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface OverCell {
  projectId: string;
  status: TaskStatus;
  invalid: boolean;
}

function BoardContent({ board, projectFilter }: { board: BoardSnapshot; projectFilter: string | null }) {
  const queryClient = useQueryClient();
  const search = useBoardView((s) => s.search);
  const attentionOnly = useBoardView((s) => s.attentionOnly);
  const hasPrOnly = useBoardView((s) => s.hasPrOnly);
  const showArchived = useBoardView((s) => s.showArchived);
  const archivedQuery = useArchivedTasks(showArchived);
  const archivedTasks = showArchived ? archivedQuery.data : undefined;
  const collapsedColumns = useBoardView((s) => s.collapsedColumns);
  const cellOverrides = useBoardView((s) => s.cellOverrides);
  const toggleColumnCollapsed = useBoardView((s) => s.toggleColumnCollapsed);
  const selectedTaskId = useSelectedTaskId();
  const openTask = useOpenTask();
  const settings = useSettings().data;
  const moveTask = useMoveTask();
  const updateProject = useUpdateProject();

  const builtLanes = useMemo(
    () => buildLanes(board, { projectId: projectFilter, search, attentionOnly, hasPrOnly }, archivedTasks),
    [board, projectFilter, search, attentionOnly, hasPrOnly, archivedTasks],
  );
  // Keep unchanged lanes referentially stable across rebuilds so memoized lanes skip rendering.
  const [stableLanes, setStableLanes] = useState({ built: builtLanes, lanes: builtLanes });
  let lanes = stableLanes.lanes;
  if (stableLanes.built !== builtLanes) {
    lanes = reuseUnchangedLanes(stableLanes.lanes, builtLanes);
    setStableLanes({ built: builtLanes, lanes });
  }
  const counts = useMemo(() => columnCounts(lanes), [lanes]);
  const laneProjectIds = useMemo(() => lanes.map((lane) => lane.project.id), [lanes]);
  const tasksById = useMemo(() => new Map(board.tasks.map((task) => [task.id, task])), [board.tasks]);
  const selectedProjectId = selectedTaskId
    ? ((tasksById.get(selectedTaskId) ?? archivedTasks?.find((task) => task.id === selectedTaskId))?.projectId ?? null)
    : null;

  const suppressClickRef = useRef(false);
  const context = useMemo<BoardContextValue>(
    () => ({
      openTask: (id) => void openTask(id),
      suppressClickRef,
      t3: board.integrations.t3,
      settings,
      projects: board.projects,
    }),
    [openTask, board.integrations.t3, settings, board.projects],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Enter opens the focused card, so only Space picks it up and drops it.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<OverCell | null>(null);
  const activeTask = activeId ? (tasksById.get(activeId) ?? null) : null;

  const endDrag = () => {
    setActiveId(null);
    setOverCell(null);
    // The click that ends a pointer drag fires right after this; swallow it.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const handleDragOver = (event: DragOverEvent) => {
    const source = readDragData(event.active.data.current);
    const target = readDragData(event.over?.data.current);
    setOverCell((current) => {
      // The card's own cell needs no highlight.
      if (!source || !target || (target.projectId === source.projectId && target.status === source.status)) return null;
      const invalid = target.projectId !== source.projectId;
      if (
        current &&
        current.projectId === target.projectId &&
        current.status === target.status &&
        current.invalid === invalid
      )
        return current;
      return { projectId: target.projectId, status: target.status, invalid };
    });
  };

  const openPlanEditor = (taskId: string) => {
    void openTask(taskId).then(() => usePanel.getState().requestPlanEditor());
  };

  const handleDragEnd = (event: DragEndEvent) => {
    endDrag();
    const { active, over } = event;
    const task = tasksById.get(String(active.id));
    const target = readDragData(over?.data.current);
    if (!task || !over || !target) return;
    const lane = lanes.find((l) => l.project.id === target.projectId);
    // Drops anchor on the cards the cell renders, so a collapsed cell never places a card among its
    // hidden ones by accident. Archived cards (Show archived) aren't siblings on the server, so they never
    // anchor a drop either.
    const allCellTasks = lane ? lane.cells[target.status] : [];
    const collapsed = isCellCollapsed(useBoardView.getState(), target.projectId, target.status);
    const cellTasks = visibleCellTasks(allCellTasks, collapsed, selectedTaskId).visible.filter((t) => !t.archivedAt);
    const overTaskId = target.type === "task" && cellTasks.some((t) => t.id === over.id) ? String(over.id) : null;
    const activeRect = active.rect.current.translated;
    const placeAfter = activeRect
      ? activeRect.top + activeRect.height / 2 > over.rect.top + over.rect.height / 2
      : false;
    const result = computeDrop({
      task,
      target,
      cellTaskIds: cellTasks.map((t) => t.id),
      overTaskId,
      placeAfter,
    });
    if (result.kind !== "move") return;
    const fullIds = allCellTasks.filter((t) => !t.archivedAt).map((t) => t.id);
    // A card that would land past the preview (say, dropped below the last shown card) would vanish, so
    // show the whole cell instead.
    if (collapsed && landsPastPreview(result, task.id, fullIds, COLUMN_PREVIEW_COUNT)) {
      useBoardView.getState().toggleCellCollapsed(target.projectId, target.status);
    }
    moveTask.mutate(
      { id: task.id, status: result.status, beforeId: result.beforeId, afterId: result.afterId },
      {
        onError: (error) => {
          if (!isPlanRequired(error)) return;
          const toastId = toastManager.add({
            type: "warning",
            title: "Plan required",
            description: `Ideas need a plan before they can move to ${STATUS_LABEL[result.status]}.`,
            actionProps: {
              children: "Write plan",
              onClick: () => {
                toastManager.close(toastId);
                openPlanEditor(task.id);
              },
            },
          });
        },
      },
    );
  };

  const handleToggleCollapsed = useCallback(
    (project: Project) => {
      const collapsed = !project.collapsed;
      // Optimistic: the server's project.upserted event confirms it.
      queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (current) =>
        current
          ? { ...current, projects: current.projects.map((p) => (p.id === project.id ? { ...p, collapsed } : p)) }
          : current,
      );
      updateProject.mutate(
        { id: project.id, collapsed },
        { onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.board }) },
      );
    },
    [queryClient, updateProject],
  );

  if (board.projects.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutGridIcon />
          </EmptyMedia>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>Add a project to start tracking ideas and tasks.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => usePalette.getState().openPalette({ kind: "add-project" })}>
            Add a project
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <BoardContext value={context}>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="w-full min-w-min pb-10">
          <div className="sticky top-0 z-10 border-b border-border/65 bg-background surface-grain">
            <div className={cn(BOARD_GRID_CLASS_NAME, "h-9 items-center")} role="row">
              {TASK_STATUSES.map(({ value, label }) => {
                const mixed = isColumnMixed({ collapsedColumns, cellOverrides }, value, laneProjectIds);
                const collapsed = !mixed && !!collapsedColumns[value];
                const action = `${collapsed ? "Expand" : "Collapse"} ${label} for every project`;
                return (
                  <div
                    key={value}
                    role="columnheader"
                    className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground"
                  >
                    {label}
                    <span className="tabular-nums text-muted-foreground/60">{counts[value]}</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost-muted"
                            size="icon-xs"
                            className="relative ms-auto"
                            aria-expanded={mixed ? undefined : !collapsed}
                            aria-label={action}
                            onClick={() => toggleColumnCollapsed(value, mixed)}
                          />
                        }
                      >
                        {collapsed ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
                        {mixed ? (
                          <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />
                        ) : null}
                      </TooltipTrigger>
                      <TooltipPopup>{mixed ? `Some projects differ. ${action}` : action}</TooltipPopup>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={endDrag}
          >
            {lanes.map((lane) => (
              <BoardLane
                key={lane.project.id}
                project={lane.project}
                cells={lane.cells}
                selectedTaskId={selectedProjectId === lane.project.id ? selectedTaskId : null}
                overStatus={overCell?.projectId === lane.project.id ? overCell.status : null}
                overInvalid={overCell?.projectId === lane.project.id ? overCell.invalid : false}
                onToggleCollapsed={handleToggleCollapsed}
              />
            ))}
            <DragOverlay>{activeTask ? <TaskCardOverlay task={activeTask} /> : null}</DragOverlay>
          </DndContext>
          {lanes.length === 0 ? (
            <p className="ps-(--workspace-gutter-start) pt-6 text-sm text-muted-foreground">
              No tasks match the current filters.
            </p>
          ) : null}
        </div>
      </div>
    </BoardContext>
  );
}
