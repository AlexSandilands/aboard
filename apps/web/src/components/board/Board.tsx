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
import { ArrowDownUpIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, LayoutGridIcon, RefreshCwIcon } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { finishSlides } from "~/lib/slide";
import { cn } from "~/lib/utils";
import { taskPanelOpen } from "~/lib/windowZoom";
import { isPlanRequired, useMoveTask, useUpdateProject, useUpdateTask } from "~/state/mutations";
import { queryKeys, useArchivedTasks, useBoard, useSettings } from "~/state/queries";
import { anyDialogOpen, useBoardPick, useBoardView, useDialogs, usePalette, usePanel, useReveal } from "~/state/ui";
import {
  buildLanes,
  COLUMN_PREVIEW_COUNT,
  columnCounts,
  findRow,
  laneRows,
  PRIORITY_ROW_ID,
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
import { PriorityLane } from "./PriorityLane";
import { useBoardFilters, useOpenTask, useProjectFilter, useSelectedTaskId } from "./boardNavigation";
import { cardClickOpens } from "./boardSelection.logic";
import { dropAnimation, snapshotCardRects, useBoardFlip } from "./cardMotion";
import {
  byPosition,
  COLUMN_SORT_LABELS,
  columnComparator,
  columnSortFor,
  columnSortOptions,
  isColumnSort,
  isSortedColumn,
  priorityLaneComparator,
  type ColumnSort,
  type ColumnSorts,
} from "./columnSort.logic";
import {
  canDropIn,
  cellDroppableId,
  homeRowId,
  containersAroundStuckLane,
  hitsAroundStuckLane,
  computeDrop,
  landsPastPreview,
  parseCellKey,
  placementAfterDrop,
  previewMove,
  previewPlacement,
  readDragData,
  samePlacement,
  sortedDrop,
  sortedLandingIndex,
  type DragPlacement,
  type OverCell,
} from "./dnd.logic";
import { DependencyLines } from "./DependencyLines";
import { advanceReveal, revealHiddenMessage, revealProgressFor, type RevealProgress } from "./reveal.logic";
import { revealCard } from "./revealCard";
import { isAppModalPath } from "~/components/layout/appModal.logic";
import { TaskCardOverlay } from "./TaskCard";

const STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<TaskStatus, string>;

/** Pointer hits prefer cards over the cell beneath them; keyboard drags fall back to corners. */
const collisionDetection: CollisionDetection = (args) => {
  const stuckLane = document.querySelector("[data-stuck]")?.getBoundingClientRect() ?? null;
  const pointer = args.pointerCoordinates;
  const hits = hitsAroundStuckLane(pointerWithin(args), pointer, stuckLane);
  if (hits.length > 0) {
    const cards = hits.filter((hit) => !String(hit.id).startsWith("cell:"));
    return cards.length > 0 ? cards : hits;
  }
  // The lane's header, the gaps between its columns and its padding hit nothing, but still belong to the lane.
  return closestCorners({
    ...args,
    droppableContainers: containersAroundStuckLane(args.droppableContainers, pointer, stuckLane),
  });
};

/**
 * Space-drag: Left/Right step to the neighbouring column of the card's lane, centred just above its
 * first card so the card lands on top; Up/Down keep sortable's stepping through the cards.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const code: string = event.code;
  const step = code === (KeyboardCode.Left as string) ? -1 : code === (KeyboardCode.Right as string) ? 1 : 0;
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
  // A Done epic's header carries the marker too but isn't sortable, so it has no rect: skip it.
  let firstRect;
  for (const card of cell.node.current.querySelectorAll<HTMLElement>("[data-task-card]")) {
    if (card.dataset.taskCard === String(active.id)) continue;
    firstRect = droppableRects.get(card.dataset.taskCard!);
    if (firstRect) break;
  }
  if (!firstRect) return { x: cellRect.left, y: cellRect.top };
  return { x: firstRect.left, y: firstRect.top + firstRect.height / 2 - collisionRect.height / 2 - 1 };
};

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };
const autoScroll = { threshold: { x: 0.12, y: 0.15 }, acceleration: 6 };

/** The main board: header, sticky column headers and one swimlane per project. */
/** The task a plain click on a card opened, and whether the docked panel was already open then. */
interface LastClicked {
  id: string;
  at: number;
  panelWasOpen: boolean;
}

/**
 * What the window of a double-click grows out of: its first click opened the panel, so the panel only counts when it
 * was open before that. Otherwise the window comes out of the card that was clicked.
 */
const doubleClickSource = (last: LastClicked | null) => (last && !last.panelWasOpen ? "card" : undefined);

/** How soon after a card's click a second one still counts as its double-click, landing off the card. */
const DOUBLE_CLICK_MS = 600;

/**
 * The second click of a double-click on a card, when it lands off every card: while the board narrows for the panel,
 * the View Transition puts its snapshot over the page and the click goes to the root. It still expands the task the
 * first click opened. A second click on a card is the card's own (`cardClickOpens`).
 */
function useDoubleClickOutsideCards(
  lastClickedRef: RefObject<LastClicked | null>,
  expand: (last: LastClicked) => void,
) {
  const onClick = useEffectEvent((event: MouseEvent) => {
    const last = lastClickedRef.current;
    if (event.detail !== 2 || event.altKey || !last || performance.now() - last.at > DOUBLE_CLICK_MS) return;
    if (event.target instanceof Element && event.target !== document.documentElement) return;
    expand(last);
  });
  useEffect(() => {
    const listener = (event: MouseEvent) => onClick(event);
    window.addEventListener("click", listener);
    return () => window.removeEventListener("click", listener);
  }, []);
}

export function Board() {
  const boardQuery = useBoard();
  const projectFilter = useProjectFilter();
  const boardTasks = boardQuery.data?.tasks;
  useEffect(() => {
    if (!boardTasks) return;
    useBoardView.getState().pruneCollapsedEpics(new Set(boardTasks.filter((t) => t.kind === "epic").map((t) => t.id)));
  }, [boardTasks]);
  // Esc drops the cards picked to plan; dialogs and menus handle their own Esc first, and so does a window over the
  // board (Settings, Stats), where Esc closes the window.
  const hasPick = useBoardPick((s) => s.picked.length > 0);
  useEffect(() => {
    if (!hasPick) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || anyDialogOpen(useDialogs.getState())) return;
      if (isAppModalPath(window.location.pathname)) return;
      useBoardPick.getState().clearPicked();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasPick]);
  // In-progress-only looks across every project, so a project scope waits (it comes back when the filter is off).
  const inProgressOnly = useBoardFilters().inProgress;
  const boardProjects = boardQuery.data?.projects;
  const scopedProjects = useMemo(
    () => (inProgressOnly ? [] : (boardProjects ?? []).filter((p) => projectFilter.includes(p.id))),
    [inProgressOnly, boardProjects, projectFilter],
  );

  const scopedIds = useMemo(() => scopedProjects.map((p) => p.id), [scopedProjects]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BoardHeader scopedProjects={scopedProjects} />
      {boardQuery.data ? (
        <BoardContent board={boardQuery.data} projectFilter={scopedIds} />
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

/** A card as the drop rules see it, given the row it shows in. */
const dropTask = (task: TaskSummary, rowId: string) => ({
  id: task.id,
  rowId,
  status: task.status,
  projectId: task.projectId,
  epicId: task.parent?.id ?? null,
});

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
  const row = rowOf(task.id);
  if (!row || !canDropIn(dropTask(task, row), target.rowId)) {
    return "Can't move there. Change a task's project or epic in its panel.";
  }
  if (target.rowId !== row)
    return `Over ${STATUS_LABEL[target.status]} in its own project; dropping it there ends its priority.`;
  const column = STATUS_LABEL[target.status];
  if (target.status === "done") return `Over ${column}; it goes on top.`;
  const sortable = data?.sortable;
  return sortable ? `Over ${column}, position ${sortable.index + 1} of ${sortable.items.length}.` : `Over ${column}.`;
}

/** The column header's sort menu. The icon is highlighted while the column is in an order other than its default. */
function ColumnSortMenu({ status, label, sorts }: { status: TaskStatus; label: string; sorts: ColumnSorts }) {
  const sort = columnSortFor(sorts, status);
  const sorted = isSortedColumn(sorts, status);
  const name = `Sort ${label}: ${COLUMN_SORT_LABELS[sort]}`;
  const choose = (value: unknown) => {
    if (!isColumnSort(value) || value === sort) return;
    // The cards slide to their new places (useBoardFlip on the sorts).
    snapshotCardRects();
    useBoardView.getState().setColumnSort(status, value);
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  data-vt-move
                  variant="ghost-muted"
                  size="icon-xs"
                  className={cn(sorted && "bg-primary/12 text-primary [:hover,[data-pressed]]:text-primary")}
                  aria-label={name}
                  data-column-sort={status}
                />
              }
            />
          }
        >
          <ArrowDownUpIcon />
        </TooltipTrigger>
        <TooltipPopup>{name}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Sort {label}</MenuGroupLabel>
          <MenuRadioGroup value={sort} onValueChange={choose}>
            {columnSortOptions(status).map((option: ColumnSort) => (
              <MenuRadioItem key={option} value={option} closeOnClick>
                {COLUMN_SORT_LABELS[option]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function BoardContent({ board, projectFilter }: { board: BoardSnapshot; projectFilter: ReadonlyArray<string> }) {
  useBoardFlip(board);
  const queryClient = useQueryClient();
  const filters = useBoardFilters();
  const priorityLane = useBoardView((s) => s.showPriorityLane);
  const pinPriorityLane = useBoardView((s) => s.pinPriorityLane);
  const showArchived = filters.archived;
  const archivedQuery = useArchivedTasks(showArchived);
  const archivedTasks = showArchived ? archivedQuery.data : undefined;
  const collapsedColumns = useBoardView((s) => s.collapsedColumns);
  const cellOverrides = useBoardView((s) => s.cellOverrides);
  const toggleColumnCollapsed = useBoardView((s) => s.toggleColumnCollapsed);
  const columnSorts = useBoardView((s) => s.columnSorts);
  // A sort change re-orders the cards without new board data, so it triggers the slide too.
  useBoardFlip(columnSorts);
  // Deferred: opening or closing a task re-renders the whole board for the highlight alone, and an urgent render
  // would block the task panel's slide for its length; deferred, React renders it in slices between frames.
  const selectedTaskId = useDeferredValue(useSelectedTaskId());
  const openTask = useOpenTask();
  // The task the last plain click opened, which the second click of a double-click expands.
  const lastClickedRef = useRef<LastClicked | null>(null);
  useDoubleClickOutsideCards(
    lastClickedRef,
    (last) => void openTask(last.id, { reveal: false, expanded: true, from: doubleClickSource(last) }),
  );
  const settings = useSettings().data;
  const moveTask = useMoveTask();
  const updateProject = useUpdateProject();
  const updateTask = useUpdateTask();

  const builtLanes = useMemo(
    () =>
      buildLanes(
        board,
        {
          projectIds: projectFilter,
          search: filters.text,
          attentionOnly: filters.attention,
          hasPrOnly: filters.hasPr,
          labels: filters.labels,
          epicId: filters.epicId,
          inProgressOnly: filters.inProgress,
          priorityLane,
          taskFilters: filters,
        },
        archivedTasks,
        columnSorts,
      ),
    [board, projectFilter, filters, priorityLane, archivedTasks, columnSorts],
  );
  // Keep unchanged lanes referentially stable across rebuilds so memoized lanes skip rendering.
  const [stableLanes, setStableLanes] = useState({ built: builtLanes, lanes: builtLanes });
  let lanes = stableLanes.lanes;
  if (stableLanes.built !== builtLanes) {
    lanes = reuseUnchangedLanes(stableLanes.lanes, builtLanes);
    setStableLanes({ built: builtLanes, lanes });
  }
  // Every row's cells can be collapsed on their own: a lane's loose cells and each epic band.
  const rowIds = useMemo(() => lanes.flatMap((lane) => laneRows(lane).map((row) => row.id)), [lanes]);
  const rows = useMemo(() => rowIndex(lanes), [lanes]);
  const tasksById = useMemo(() => new Map(board.tasks.map((task) => [task.id, task])), [board.tasks]);
  // Archived cards shown by Show archived take part in the dependency lines too.
  const lineTasks = useMemo(
    () => (archivedTasks ? [...board.tasks, ...archivedTasks.filter((t) => !tasksById.has(t.id))] : board.tasks),
    [board.tasks, archivedTasks, tasksById],
  );
  const selectedProjectId = selectedTaskId
    ? ((tasksById.get(selectedTaskId) ?? archivedTasks?.find((task) => task.id === selectedTaskId))?.projectId ?? null)
    : null;

  const suppressClickRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const context = useMemo<BoardContextValue>(
    () => ({
      openTask: (id, click) => {
        switch (cardClickOpens(click)) {
          case "open":
            lastClickedRef.current = { id, at: performance.now(), panelWasOpen: taskPanelOpen() };
            return void openTask(id, { reveal: false, expanded: false });
          case "window":
            return void openTask(id, { reveal: false, expanded: true });
          case "expand":
            // The task the first click opened, by id: its navigation may not have landed yet, and the card under
            // this click may be another one, moved there as the board narrowed.
            return void openTask(lastClickedRef.current?.id ?? id, {
              reveal: false,
              expanded: true,
              from: doubleClickSource(lastClickedRef.current),
            });
          case "none":
            return;
        }
      },
      revealTask: (id) => void openTask(id),
      openPlanEditor: (id) => void openTask(id, { reveal: false }).then(() => usePanel.getState().requestPlanEditor()),
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
  const [activeCompact, setActiveCompact] = useState(false);
  const [overCell, setOverCell] = useState<OverCell | null>(null);
  // Where the dragged card shows while over another column; the lanes render this preview.
  const [placement, setPlacement] = useState<DragPlacement | null>(null);
  // After a drop the placement holds the card's final slot until the optimistic move reaches the
  // lanes: Query notifies a tick after the write, and until then the card would flash back to its
  // old slot, which is also where the drop animation would fly. It waits for the board data rather than the lanes:
  // a reorder that turns a column's sort off rebuilds the lanes at once, before the move is in.
  const [settlingFrom, setSettlingFrom] = useState<BoardSnapshot | null>(null);
  if (settlingFrom && settlingFrom !== board) {
    setSettlingFrom(null);
    setPlacement(null);
  }
  const shownLanes = useMemo(() => previewMove(lanes, placement), [lanes, placement]);
  const counts = useMemo(() => columnCounts(shownLanes), [shownLanes]);
  const activeTask = activeId ? (tasksById.get(activeId) ?? null) : null;
  const activeRowId = activeTask ? (rows.get(activeTask.id) ?? null) : null;
  const projectRank = useMemo(() => new Map(board.projects.map((p, index) => [p.id, index])), [board.projects]);
  /** Where a card brought into a sorted column lands in `cell`, or null when the column is in its default order. */
  const sortedIndex = (
    at: { rowId: string; status: TaskStatus },
    cell: ReadonlyArray<TaskSummary>,
    task: TaskSummary,
  ): number | null => {
    if (!isSortedColumn(columnSorts, at.status)) return null;
    const sort = columnSortFor(columnSorts, at.status);
    // The priority lane keeps its cards grouped by project, as buildLanes does.
    const compare =
      at.rowId === PRIORITY_ROW_ID
        ? priorityLaneComparator(sort, (t) => projectRank.get(t.projectId) ?? 0)
        : columnComparator(sort);
    return sortedLandingIndex(cell, task, at.status, compare, new Date().toISOString());
  };
  /** A card as the drag logic sees it: in its row rather than just its project. */
  const inRow = (task: TaskSummary) => dropTask(task, rows.get(task.id) ?? task.projectId);

  /** A cell's cards and the ones it renders, as BoardCell works them out; drops anchor on the latter. */
  const renderedCell = (source: ReadonlyArray<Lane>, at: { rowId: string; status: TaskStatus }, draggedId: string) => {
    const cell = findRow(source, at.rowId)?.cells[at.status] ?? [];
    const collapsed = isCellCollapsed(useBoardView.getState(), at.rowId, at.status);
    return { cell, collapsed, visible: visibleCellTasks(cell, collapsed, [selectedTaskId, draggedId]).visible };
  };

  // The dragged card's cell keeps its height until the drag ends (see handleDragStart).
  const heldCellRef = useRef<HTMLElement | null>(null);

  const endDrag = () => {
    heldCellRef.current?.style.removeProperty("min-height");
    heldCellRef.current = null;
    setActiveId(null);
    setActiveCompact(false);
    setOverCell(null);
    setPlacement(null);
    setSettlingFrom(null);
    // The click that ends a pointer drag fires right after this; swallow it.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleDragStart = (event: DragStartEvent) => {
    // dnd-kit measures the columns now; a slide still resizing the board would leave those rects stale.
    finishSlides();
    setActiveId(String(event.active.id));
    // A card lifted out of the stuck lane is one line, so the lifted copy is too.
    const node = document.querySelector(`[data-task-card="${CSS.escape(String(event.active.id))}"]`);
    setActiveCompact(!!node?.closest("[data-stuck]"));
    // The preview moves the card out of its cell. If that shrank its row, the lanes below (or, in the
    // last lane, the scroll position) would move under a still pointer, the next measure would put the
    // card back, the row would grow again, and so on until React stops with "Maximum update depth
    // exceeded". Cells stretch to their row, so holding this one's height keeps the row from shrinking.
    const cell = node?.closest<HTMLElement>("[data-board-cell]");
    if (cell) {
      cell.style.minHeight = `${cell.getBoundingClientRect().height}px`;
      heldCellRef.current = cell;
    }
  };

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
      const invalid = !canDropIn(task, target.rowId);
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
      const preview = previewPlacement({
        task,
        target,
        cellTaskIds: cell.map((t) => t.id),
        overTaskId,
        placeAfter,
      });
      // A sorted column has no slot to choose: the gap opens where the sort will put the card.
      const landing = preview ? sortedIndex(target, cell, found) : null;
      const next = preview && landing !== null ? { ...preview, index: landing } : preview;
      return samePlacement(current, next) ? current : next;
    });
  };

  const openPlanEditor = (taskId: string) => {
    void openTask(taskId, { reveal: false }).then(() => usePanel.getState().requestPlanEditor());
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
    const sameCell = target.rowId === task.rowId && target.status === task.status;
    const { result, resetToManual } = sortedDrop(
      computeDrop({ task, target, cellTaskIds: cellTasks.map((t) => t.id), overTaskId }),
      isSortedColumn(columnSorts, target.status),
      sameCell,
    );
    if (result.kind === "invalid") return;
    if (result.kind === "noop" && !result.clearPriority) return;
    // A card dropped on its own project leaves the priority lane. With a move, that waits until the move has landed,
    // so a refused move (a plan is required, say) leaves the card in the lane. The card is patched at once, as a move
    // is, so it doesn't wait for the server's event; a refetch undoes it if the update fails.
    const clearPriority = () => {
      queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (current) =>
        current
          ? { ...current, tasks: current.tasks.map((t) => (t.id === task.id ? { ...t, priority: false } : t)) }
          : current,
      );
      updateTask.mutate(
        { id: task.id, priority: false },
        { onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.board }) },
      );
    };
    if (result.kind === "noop") {
      clearPriority();
      return;
    }
    if (result.kind !== "move") return;
    if (resetToManual) {
      // The column shows positions again, the dropped card among them where it was let go.
      useBoardView.getState().setColumnSort(target.status, "manual");
      toastManager.add({
        type: "info",
        title: `${STATUS_LABEL[target.status]} is back to manual order`,
        description: "Reordering cards by hand turns the column's sort off. Pick a sort again from its header.",
      });
    }
    // Once the drag ends, a card that landed past a collapsed cell's preview (say, below its last shown
    // card) would vanish, so show the whole cell instead. Archived cards take preview slots too.
    // Turned back to Manual, the cell shows by position, so that is the order the preview is counted in.
    const shownBefore = renderedCell(lanes, target, task.id).cell;
    const before = resetToManual ? [...shownBefore].sort(byPosition) : shownBefore;
    const landing = resetToManual ? null : sortedIndex(target, before, found);
    const pastPreview =
      landing !== null
        ? landing >= COLUMN_PREVIEW_COUNT
        : landsPastPreview(
            result,
            task.id,
            before.map((t) => t.id),
            COLUMN_PREVIEW_COUNT,
          );
    if (shown.collapsed && pastPreview) {
      useBoardView.getState().toggleCellCollapsed(target.rowId, target.status);
    }
    // Leaving the priority lane, the card shows where it lands once the cache has it, which isn't this row.
    if (!result.clearPriority) {
      // Back on Manual, the cell shows by position, so that is the order the card's neighbours are found in.
      const order = resetToManual ? [...shown.cell].sort(byPosition) : shown.cell;
      const after = placementAfterDrop(
        task,
        order.map((t) => t.id),
        result,
      );
      setPlacement(landing === null ? after : { ...after, index: landing });
      setSettlingFrom(board);
    }
    moveTask.mutate(
      { id: task.id, status: result.status, beforeId: result.beforeId, afterId: result.afterId },
      {
        onSuccess: () => {
          if (result.clearPriority) clearPriority();
        },
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

  // A task opened from outside the board (search, a link, a notification): bring its card into view. The steps run
  // as the board changes (advanceReveal): expand what hides the card, then scroll once it is on screen. A card a
  // filter leaves out is skipped, and the filters stay as they are.
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnHeaderRef = useRef<HTMLDivElement>(null);
  const reveal = useReveal((s) => s.request);
  const collapsedEpics = useBoardView((s) => s.collapsedEpics);
  const revealExpanded = useRef<RevealProgress | null>(null);
  useEffect(() => {
    if (!reveal) return;
    revealExpanded.current = revealProgressFor(revealExpanded.current, reveal.nonce);
    const ids = revealExpanded.current.expanded;
    const cardSelector = `[data-task-card="${CSS.escape(reveal.taskId)}"]`;
    const action = advanceReveal({
      taskId: reveal.taskId,
      age: Date.now() - reveal.at,
      lanes,
      collapsedEpics,
      expanded: ids,
      selectedTaskId,
      cardDrawn: () => !!scrollRef.current?.querySelector(cardSelector),
    });
    switch (action.kind) {
      case "wait":
        return;
      case "drop":
        useReveal.getState().consumeReveal(reveal.nonce);
        // Only a jump the user asked for explains itself; opening a task from elsewhere stays quiet.
        if (reveal.explicit && action.reason === "hidden")
          toastManager.add({
            type: "info",
            title: "Can't jump to the card",
            description: revealHiddenMessage(tasksById.get(reveal.taskId)?.number),
          });
        return;
      case "expand-lane":
        ids.add(action.project.id);
        handleToggleCollapsed(action.project);
        return;
      case "expand-band":
        ids.add(action.epicId);
        useBoardView.getState().toggleEpicCollapsed(action.epicId);
        return;
      case "scroll": {
        // Consumed first, so a board that remounts within the window doesn't scroll again.
        useReveal.getState().consumeReveal(reveal.nonce);
        const card = scrollRef.current?.querySelector(cardSelector);
        if (card) revealCard(scrollRef.current!, columnHeaderRef.current, card);
      }
    }
  }, [reveal, lanes, collapsedEpics, selectedTaskId, handleToggleCollapsed, tasksById]);

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
      {/* Opaque, with the grain scrolling along (bg-local), so Chromium scrolls it on the compositor. Over the main
          area's background instead it kept subpixel text by repainting the whole screen every scroll frame. */}
      <div
        ref={scrollRef}
        data-board-scroll
        className="min-h-0 flex-1 overflow-auto bg-background surface-grain bg-local"
      >
        <div ref={contentRef} className="relative w-full min-w-min pb-10">
          {/* Its height (h-9 and the border) is also the pinned priority lane's sticky `top` in PriorityLane. */}
          <div
            ref={columnHeaderRef}
            className="sticky top-0 z-10 border-b border-border/65 bg-background surface-grain"
          >
            <div className={cn(BOARD_GRID_CLASS_NAME, "h-9 items-center")} role="row">
              {TASK_STATUSES.map(({ value, label }) => {
                const mixed = isColumnMixed({ collapsedColumns, cellOverrides }, value, rowIds);
                const collapsed = !mixed && !!collapsedColumns[value];
                const action = `${collapsed ? "Expand" : "Collapse"} ${label} for every project`;
                return (
                  <div
                    key={value}
                    role="columnheader"
                    data-vt-move
                    className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground"
                  >
                    {label}
                    <span className="tabular-nums text-muted-foreground/60">{counts[value]}</span>
                    <span className="ms-auto flex items-center gap-0.5">
                      <ColumnSortMenu status={value} label={label} sorts={columnSorts} />
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              data-vt-move
                              variant="ghost-muted"
                              size="icon-xs"
                              className="relative"
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
                    </span>
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
            // Dragged from the stuck lane, the board's top scroll zone would reach the lane's first rows and scroll the
            // board up until the lane unsticks; the wheel still scrolls.
            autoScroll={activeCompact ? false : autoScroll}
            accessibility={{ announcements }}
          >
            {shownLanes.map((lane) => {
              const overHere = overCell && laneRows(lane).some((row) => row.id === overCell.rowId) ? overCell : null;
              if (lane.priority) {
                return (
                  <PriorityLane
                    key={lane.project.id}
                    cells={lane.cells}
                    selectedTaskId={selectedTaskId}
                    draggingTaskId={activeRowId === PRIORITY_ROW_ID ? (activeTask?.id ?? null) : null}
                    overCell={overHere}
                    columnHeaderRef={columnHeaderRef}
                  />
                );
              }
              return (
                <BoardLane
                  key={lane.project.id}
                  project={lane.project}
                  cells={lane.cells}
                  epicChildren={lane.epicChildren}
                  selectedTaskId={selectedProjectId === lane.project.id ? selectedTaskId : null}
                  bands={lane.bands}
                  draggingTaskId={activeTask?.projectId === lane.project.id ? activeTask.id : null}
                  draggingRowId={activeTask?.projectId === lane.project.id ? activeRowId : null}
                  homeRowId={
                    activeTask?.projectId === lane.project.id && activeRowId === PRIORITY_ROW_ID
                      ? homeRowId(
                          dropTask(activeTask, PRIORITY_ROW_ID),
                          lane.bands.map((band) => band.id),
                        )
                      : null
                  }
                  overCell={overHere}
                  onToggleCollapsed={handleToggleCollapsed}
                />
              );
            })}
            <DragOverlay dropAnimation={dropAnimation()}>
              {activeTask ? (
                <TaskCardOverlay
                  task={activeTask}
                  showProject={activeRowId === PRIORITY_ROW_ID}
                  compact={activeCompact}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
          {lanes.length === 0 ? (
            <p className="ps-(--workspace-gutter-start) pt-6 text-sm text-muted-foreground">
              No tasks match the current filters.
            </p>
          ) : null}
          <DependencyLines
            containerRef={contentRef}
            tasks={lineTasks}
            projects={board.projects}
            priorityLane={lanes.some((lane) => lane.priority)}
            pinnedLane={pinPriorityLane && lanes.some((lane) => lane.priority)}
            selectedTaskId={selectedTaskId}
            suspended={activeId !== null}
          />
        </div>
      </div>
    </BoardContext>
  );
}
