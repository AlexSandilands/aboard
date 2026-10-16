import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type Over,
  type UniqueIdentifier,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { TASK_STATUSES, type BoardSnapshot, type Project, type TaskStatus, type TaskSummary } from "@repo/contracts";
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
  findRow,
  laneRows,
  reuseUnchangedLanes,
  rowIndex,
  STATUS_ORDER,
  visibleCellTasks,
  type Lane,
} from "./board.logic";
import { isCellCollapsed, isColumnMixed } from "./columnCollapse.logic";
import { BoardContext, type BoardContextValue } from "./BoardContext";
import { BoardHeader } from "./BoardHeader";
import { BOARD_GRID_CLASS_NAME, BoardLane } from "./BoardLane";
import { useEpicFilter, useLabelFilter, useOpenTask, useProjectFilter, useSelectedTaskId } from "./boardNavigation";
import { dropAnimation } from "./cardMotion";
import {
  cellDroppableId,
  computeDrop,
  landsPastPreview,
  parseCellKey,
  placementAfterDrop,
  previewMove,
  previewPlacement,
  readDragData,
  samePlacement,
  type DragPlacement,
  type OverCell,
} from "./dnd.logic";
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

/**
 * Space-drag: Left/Right step to the neighbouring column of the card's lane, centred just above its
 * first card so the card lands on top; Up/Down keep sortable's stepping through the cards.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const code = event.code as KeyboardCode;
  const step = code === KeyboardCode.Left ? -1 : code === KeyboardCode.Right ? 1 : 0;
  if (step === 0) return sortableKeyboardCoordinates(event, args);
  event.preventDefault();
  const { active, collisionRect, droppableContainers, droppableRects } = args.context;
  // The cell the card shows in now: its sortable container moves with the drag preview.
  const at = parseCellKey(active?.data.current?.sortable?.containerId);
  if (!active || !collisionRect || !at) return undefined;
  const status = STATUS_ORDER[STATUS_ORDER.indexOf(at.status) + step];
  if (!status) return undefined;
  const cell = droppableContainers.get(cellDroppableId(at.rowId, status));
  const cellRect = cell ? droppableRects.get(cell.id) : undefined;
  if (!cell?.node.current || !cellRect) return undefined;
  const firstCard = cell.node.current.querySelector<HTMLElement>(
    `[data-task-card]:not([data-task-card="${CSS.escape(String(active.id))}"])`,
  );
  const firstRect = firstCard ? droppableRects.get(firstCard.dataset.taskCard!) : undefined;
  if (!firstRect) return { x: cellRect.left, y: cellRect.top };
  return { x: firstRect.left, y: firstRect.top + firstRect.height / 2 - collisionRect.height / 2 - 1 };
};

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };
const autoScroll = { threshold: { x: 0.12, y: 0.15 }, acceleration: 6 };

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

/** Screen-reader text for where a dragged card is: its column and slot, or why it can't go there. */
function describeOver(
  activeId: UniqueIdentifier,
  over: Over | null,
  tasksById: ReadonlyMap<string, TaskSummary>,
  rowOf: (taskId: string) => string | undefined,
): string | undefined {
  const task = tasksById.get(String(activeId));
  const data = over?.data.current as
    | { sortable?: { containerId: unknown; index: number; items: unknown[] } }
    | undefined;
  // A card's sortable container follows the drag preview; its own status doesn't.
  const target = parseCellKey(data?.sortable?.containerId) ?? readDragData(data);
  if (!task || !over || !target) return undefined;
  if (target.rowId !== rowOf(task.id)) return "Can't move there. Change a task's project or epic in its panel.";
  const column = STATUS_LABEL[target.status];
  if (target.status === "done") return `Over ${column}; it goes on top.`;
  const sortable = data?.sortable;
  return sortable ? `Over ${column}, position ${sortable.index + 1} of ${sortable.items.length}.` : `Over ${column}.`;
}

function BoardContent({ board, projectFilter }: { board: BoardSnapshot; projectFilter: string | null }) {
  const queryClient = useQueryClient();
  const search = useBoardView((s) => s.search);
  const attentionOnly = useBoardView((s) => s.attentionOnly);
  const hasPrOnly = useBoardView((s) => s.hasPrOnly);
  const labels = useLabelFilter();
  const epicId = useEpicFilter();
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
    () =>
      buildLanes(board, { projectId: projectFilter, search, attentionOnly, hasPrOnly, labels, epicId }, archivedTasks),
    [board, projectFilter, search, attentionOnly, hasPrOnly, labels, epicId, archivedTasks],
  );
  // Keep unchanged lanes referentially stable across rebuilds so memoized lanes skip rendering.
  const [stableLanes, setStableLanes] = useState({ built: builtLanes, lanes: builtLanes });
  let lanes = stableLanes.lanes;
  if (stableLanes.built !== builtLanes) {
    lanes = reuseUnchangedLanes(stableLanes.lanes, builtLanes);
    setStableLanes({ built: builtLanes, lanes });
  }
  const laneProjectIds = useMemo(() => lanes.map((lane) => lane.project.id), [lanes]);
  const rows = useMemo(() => rowIndex(lanes), [lanes]);
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
      labelColors: board.labelColors,
    }),
    [openTask, board.integrations.t3, settings, board.projects, board.labelColors],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Enter opens the focused card, so only Space picks it up and drops it.
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overCell, setOverCell] = useState<OverCell | null>(null);
  // Where the dragged card shows while over another column; the lanes render this preview.
  const [placement, setPlacement] = useState<DragPlacement | null>(null);
  // After a drop the placement holds the card's final slot until the optimistic move reaches the
  // lanes: Query notifies a tick after the write, and until then the card would flash back to its
  // old slot, which is also where the drop animation would fly.
  const [settlingFrom, setSettlingFrom] = useState<ReadonlyArray<Lane> | null>(null);
  if (settlingFrom && settlingFrom !== lanes) {
    setSettlingFrom(null);
    setPlacement(null);
  }
  const shownLanes = useMemo(() => previewMove(lanes, placement), [lanes, placement]);
  const counts = useMemo(() => columnCounts(shownLanes), [shownLanes]);
  const activeTask = activeId ? (tasksById.get(activeId) ?? null) : null;
  const activeRowId = activeTask ? (rows.get(activeTask.id) ?? null) : null;
  /** A card as the drag logic sees it: in its row rather than just its project. */
  const inRow = (task: TaskSummary) => ({ ...task, rowId: rows.get(task.id) ?? task.projectId });

  /** A cell's cards and the ones it renders, as BoardCell works them out; drops anchor on the latter. */
  const renderedCell = (source: ReadonlyArray<Lane>, at: { rowId: string; status: TaskStatus }, draggedId: string) => {
    const cell = findRow(source, at.rowId)?.cells[at.status] ?? [];
    const collapsed = isCellCollapsed(useBoardView.getState(), at.rowId, at.status);
    return { cell, collapsed, visible: visibleCellTasks(cell, collapsed, [selectedTaskId, draggedId]).visible };
  };

  const endDrag = () => {
    setActiveId(null);
    setOverCell(null);
    setPlacement(null);
    setSettlingFrom(null);
    // The click that ends a pointer drag fires right after this; swallow it.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    const found = tasksById.get(String(active.id));
    // Over its own placeholder the card stays put; over nothing (a gap) keeps the last preview.
    if (!found || !over || over.id === active.id) return;
    const task = inRow(found);
    const target = readDragData(over.data.current);
    if (!target) return;
    setOverCell((current) => {
      // The card's own cell needs no highlight.
      if (target.rowId === task.rowId && target.status === task.status) return null;
      const invalid = target.rowId !== task.rowId;
      if (current && current.rowId === target.rowId && current.status === target.status && current.invalid === invalid)
        return current;
      return { rowId: target.rowId, status: target.status, invalid };
    });
    setPlacement((current) => {
      // Inside the cell the card already shows in, sortable moves the cards; the preview stays.
      const shownIn = current ?? task;
      if (target.rowId === shownIn.rowId && target.status === shownIn.status) return current;
      const cell = renderedCell(lanes, target, task.id).visible;
      const overTaskId = target.type === "task" ? String(over.id) : null;
      const activeRect = active.rect.current.translated;
      const placeAfter = activeRect
        ? activeRect.top + activeRect.height / 2 > over.rect.top + over.rect.height / 2
        : false;
      const next = previewPlacement({
        task,
        target,
        cellTaskIds: cell.map((t) => t.id),
        overTaskId,
        placeAfter,
      });
      return samePlacement(current, next) ? current : next;
    });
  };

  const openPlanEditor = (taskId: string) => {
    void openTask(taskId).then(() => usePanel.getState().requestPlanEditor());
  };

  const handleDragEnd = (event: DragEndEvent) => {
    endDrag();
    const { active, over } = event;
    const found = tasksById.get(String(active.id));
    if (!found || !over) return;
    const task = inRow(found);
    // Dropped on its own placeholder: it lands where the preview shows it.
    const target = over.id === active.id ? (placement ?? task) : readDragData(over.data.current);
    if (!target) return;
    const shown = renderedCell(shownLanes, target, task.id);
    // Archived cards (Show archived) aren't siblings on the server, so they never anchor a drop.
    const cellTasks = shown.visible.filter((t) => !t.archivedAt);
    const overTaskId = cellTasks.some((t) => t.id === over.id) ? String(over.id) : null;
    const result = computeDrop({ task, target, cellTaskIds: cellTasks.map((t) => t.id), overTaskId });
    if (result.kind !== "move") return;
    // Once the drag ends, a card that landed past a collapsed cell's preview (say, below its last shown
    // card) would vanish, so show the whole cell instead. Archived cards take preview slots too.
    const before = renderedCell(lanes, target, task.id).cell.map((t) => t.id);
    if (shown.collapsed && landsPastPreview(result, task.id, before, COLUMN_PREVIEW_COUNT)) {
      useBoardView.getState().toggleCellCollapsed(target.rowId, target.status);
    }
    setPlacement(
      placementAfterDrop(
        task,
        shown.cell.map((t) => t.id),
        result,
      ),
    );
    setSettlingFrom(lanes);
    moveTask.mutate(
      { id: task.id, status: result.status, beforeId: result.beforeId, afterId: result.afterId },
      {
        onError: (error) => {
          if (!isPlanRequired(error)) return;
          const toastId = toastManager.add({
            type: "warning",
            title: "Plan required",
            description: `Tasks need a plan before they can move to ${STATUS_LABEL[result.status]}.`,
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

  const rowOf = (taskId: string) => rows.get(taskId);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const task = tasksById.get(String(active.id));
      return task ? `Picked up #${task.number} in ${STATUS_LABEL[task.status]}.` : undefined;
    },
    onDragOver: ({ active, over }) => describeOver(active.id, over, tasksById, rowOf),
    onDragEnd: ({ active, over }) => {
      const where = describeOver(active.id, over, tasksById, rowOf);
      return where ? `Dropped. ${where}` : "Dropped.";
    },
    onDragCancel: () => "Cancelled. The card is back where it was.",
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
          <EmptyDescription>Add a project to start tracking tasks.</EmptyDescription>
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
            measuring={measuring}
            autoScroll={autoScroll}
            accessibility={{ announcements }}
          >
            {shownLanes.map((lane) => (
              <BoardLane
                key={lane.project.id}
                project={lane.project}
                cells={lane.cells}
                selectedTaskId={selectedProjectId === lane.project.id ? selectedTaskId : null}
                bands={lane.bands}
                draggingTaskId={activeTask?.projectId === lane.project.id ? activeTask.id : null}
                draggingRowId={activeTask?.projectId === lane.project.id ? activeRowId : null}
                overCell={overCell && laneRows(lane).some((row) => row.id === overCell.rowId) ? overCell : null}
                onToggleCollapsed={handleToggleCollapsed}
              />
            ))}
            <DragOverlay dropAnimation={dropAnimation()}>
              {activeTask ? <TaskCardOverlay task={activeTask} /> : null}
            </DragOverlay>
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
