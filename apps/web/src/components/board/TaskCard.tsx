import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskSummary } from "@repo/contracts";
import { ArchiveIcon, LockIcon, StarIcon } from "lucide-react";
import { memo, useCallback, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { AutopilotBadge } from "~/components/autopilot/AutopilotBadge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useUpdateTask } from "~/state/mutations";
import { useBoardPick } from "~/state/ui";
import { importPendingLabel } from "~/components/task/import.logic";
import { resolutionLabel } from "~/components/task/resolution.logic";
import { Spinner } from "~/components/ui/spinner";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { AttentionIcon } from "./attention";
import { ATTENTION_LABELS, jiraKeys, PRIORITY_ROW_ID, topAttention } from "./board.logic";
import { useBoardContext } from "./BoardContext";
import { canPickTask, isPickClick } from "./boardSelection.logic";
import { blockedLabel } from "./dependencies.logic";
import { CardLinks, chipClassName, hasCardLinks, linkHandlers } from "./CardLinks";
import { canStartT3Thread, showHandoffActions } from "~/components/handoff/handoff.logic";
import { HandoffMenu } from "~/components/handoff/HandoffActions";
import { LabelChip } from "~/components/labels/LabelChip";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { ReviewBadge } from "~/components/review/ReviewBadge";
import { useCardFlip } from "./cardMotion";
import type { DragData } from "./dnd.logic";
import { TaskProgressLine } from "./TaskProgress";

/** Card surface: settings-group card with sidebar-row selection; attention adds a tinted ring. */
export function taskCardClassName(task: TaskSummary, selected: boolean) {
  const attention = topAttention(task.attention);
  return cn(
    "relative w-full cursor-pointer select-none rounded-xl border border-border/60 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    selected ? "bg-sidebar-row-selected ring-1 ring-ring/40" : "bg-card/40 hover:bg-accent/40",
    !selected && attention && (attention.severity === "error" ? "ring-1 ring-error/40" : "ring-1 ring-warning/40"),
    task.archivedAt && "opacity-60",
  );
}

/** The card's lines. Memoized on the task object, which the board reducer keeps stable. */
export const TaskCardContent = memo(function TaskCardContent({
  task,
  archivable = false,
  showProject = false,
}: {
  task: TaskSummary;
  /** Shows the quick Archive button on Done cards and the priority star. Off for the drag overlay. */
  archivable?: boolean;
  /** Names the card's project: in the priority lane, where cards of every project mix. */
  showProject?: boolean;
}) {
  const attention = topAttention(task.attention);
  const blocked = blockedLabel(task);
  const fetching = importPendingLabel(task);
  const jiraKey = jiraKeys(task)[0];
  const { t3, settings, projects } = useBoardContext();
  const project = showProject ? projects.find((p) => p.id === task.projectId) : undefined;
  const handoff = showHandoffActions(task);
  const startT3 =
    handoff &&
    canStartT3Thread(
      task,
      projects.find((p) => p.id === task.projectId),
      t3,
      settings,
    );
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">#{task.number}</span>
        {jiraKey ? (
          <Badge variant="outline" size="sm">
            {jiraKey}
          </Badge>
        ) : null}
        {project ? (
          <span
            title={project.title}
            className="flex min-w-0 max-w-28 shrink items-center gap-1 rounded-md border border-border/60 px-1 text-2xs text-muted-foreground"
          >
            <ProjectFavicon title={project.title} icon={project.icon} className="size-3 shrink-0" />
            <span className="truncate">{project.title}</span>
          </span>
        ) : null}
        <ResolutionChip task={task} />
        {task.review && !task.resolution ? <ReviewBadge summary={task.review} /> : null}
        <AutopilotBadge taskId={task.id} />
        {task.archivedAt ? (
          <Badge variant="secondary" size="sm">
            Archived
          </Badge>
        ) : null}
        {fetching ? (
          <span className="flex min-w-0 shrink-0 items-center gap-1 text-muted-foreground">
            <Spinner size="xs" />
            {fetching}
          </span>
        ) : null}
        {blocked ? (
          <span title={blocked} className="flex shrink-0 text-muted-foreground">
            <LockIcon aria-hidden className="size-3.5" />
            <span className="sr-only">{blocked}</span>
          </span>
        ) : null}
        {attention ? (
          <span title={attention.message} className="flex shrink-0">
            <AttentionIcon severity={attention.severity} />
            <span className="sr-only">{ATTENTION_LABELS[attention.kind]}</span>
          </span>
        ) : null}
        <span
          className="ml-auto shrink-0 tabular-nums text-secondary-label"
          title={new Date(task.updatedAt).toLocaleString()}
        >
          {formatElapsedDurationLabel(task.updatedAt)}
        </span>
        {archivable && task.kind !== "epic" && !task.archivedAt ? <PriorityButton task={task} /> : null}
        {archivable && task.status === "done" && !task.archivedAt ? <ArchiveButton task={task} /> : null}
      </div>
      <p className="line-clamp-2 text-sm font-medium text-foreground/90 [overflow-wrap:anywhere]">{task.title}</p>
      {task.labels.length ? <CardLabels labels={task.labels} /> : null}
      <TaskProgressLine task={task} />
      {hasCardLinks(task.links) || handoff ? (
        <div className="flex min-w-0 items-center gap-1">
          <CardLinks task={task} />
          {handoff ? (
            <div className="ms-auto flex shrink-0 items-center gap-0.5">
              <HandoffMenu task={task} variant="card" canStartT3={startT3} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** Cards show this many labels; the rest collapse into "+N". */
const CARD_LABEL_LIMIT = 3;

function CardLabels({ labels }: { labels: ReadonlyArray<string> }) {
  const { labelColors } = useBoardContext();
  const shown = labels.slice(0, CARD_LABEL_LIMIT);
  const hidden = labels.slice(CARD_LABEL_LIMIT);
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden" aria-label={`Labels: ${labels.join(", ")}`}>
      {shown.map((label) => (
        <LabelChip key={label} label={label} colors={labelColors} className="max-w-28" />
      ))}
      {hidden.length ? (
        <span className="shrink-0 text-2xs text-muted-foreground" title={hidden.join(", ")}>
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The priority star: filled on a priority card, and on hover or focus a way to set it on any card. Must not open the
 * panel or start a drag, like the card's links.
 */
function PriorityButton({ task }: { task: TaskSummary }) {
  const { mutate: updateTask, isPending } = useUpdateTask();
  const label = task.priority ? `Remove priority from #${task.number}` : `Mark #${task.number} as priority`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "-my-1 size-6 shrink-0",
              task.priority
                ? "text-warning"
                : "text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100",
            )}
            aria-label={label}
            aria-pressed={task.priority}
            disabled={isPending}
            {...linkHandlers}
            onClick={(event) => {
              event.stopPropagation();
              updateTask({ id: task.id, priority: !task.priority });
            }}
          />
        }
      >
        <StarIcon className={cn(task.priority && "fill-current")} />
      </TooltipTrigger>
      <TooltipPopup>{task.priority ? "Remove priority" : "Mark as priority"}</TooltipPopup>
    </Tooltip>
  );
}

/** Quick archive for Done cards. Must not open the panel or start a drag, like the card's links. */
export function ArchiveButton({ task }: { task: TaskSummary }) {
  const { mutate: updateTask, isPending } = useUpdateTask();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="-my-1 -me-1 size-6 shrink-0"
            aria-label={`Archive #${task.number}`}
            disabled={isPending}
            {...linkHandlers}
            onClick={(event) => {
              event.stopPropagation();
              updateTask({ id: task.id, archived: true });
            }}
          />
        }
      >
        <ArchiveIcon />
      </TooltipTrigger>
      <TooltipPopup>Archive</TooltipPopup>
    </Tooltip>
  );
}

/** Muted "Done by #4" / "Duplicate of #4" / "Won't do" on closed cards; the number opens the delivering task. */
function ResolutionChip({ task }: { task: TaskSummary }) {
  const { openTask } = useBoardContext();
  const label = resolutionLabel(task);
  if (!label) return null;
  const by = task.resolvedBy;
  if (!by) return <span className="min-w-0 truncate text-muted-foreground">{label}</span>;
  return (
    <button
      type="button"
      title={`#${by.number} ${by.title}`}
      aria-label={`${label}: open #${by.number} ${by.title}`}
      className={cn(chipClassName, "font-normal")}
      {...linkHandlers}
      onClick={(event) => {
        event.stopPropagation();
        openTask(by.id);
      }}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * A draggable card in a board cell. Click or Enter opens the detail panel; Space picks it up. Ctrl/⌘-click picks it
 * to plan with others (see boardSelection.logic) instead.
 */
export const SortableTaskCard = memo(function SortableTaskCard({
  task,
  rowId,
  selected,
}: {
  task: TaskSummary;
  /** The row the card shows in (see Row in board.logic). */
  rowId: string;
  selected: boolean;
}) {
  const { openTask, suppressClickRef } = useBoardContext();
  const data: DragData = { type: "task", rowId, status: task.status };
  // Archived cards (Show archived) open in the panel but can't be dragged; unarchive first.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data,
    disabled: !!task.archivedAt,
  });
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );
  useCardFlip(task.id, nodeRef, `${task.status}:${task.position}`);
  const picked = useBoardPick((s) => s.picked.includes(task.id));
  const pickable = canPickTask(task);

  const open = () => {
    if (suppressClickRef.current) return;
    useBoardPick.getState().clearPicked();
    openTask(task.id);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isPickClick(event)) return open();
    event.preventDefault();
    if (pickable) useBoardPick.getState().togglePicked(task.id);
  };

  return (
    <div
      ref={ref}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      // A Ctrl/⌘-press picks the card, so it never starts a drag.
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (!isPickClick(event)) listeners?.onPointerDown?.(event);
      }}
      // Restates dnd-kit's defaults so the card's semantics are visible statically.
      role="button"
      tabIndex={0}
      aria-label={`#${task.number} ${task.title}${picked ? " (picked to plan)" : ""}`}
      aria-current={selected || undefined}
      data-task-card={task.id}
      className={cn(
        taskCardClassName(task, selected),
        "group/card",
        // !important beats dnd-kit's inline transition, which slides cards aside while sorting.
        "[contain-intrinsic-size:auto_84px] [content-visibility:auto] motion-reduce:transition-none!",
        isDragging && "opacity-40",
        // Inside the card: content-visibility clips anything drawn outside it.
        picked && "bg-primary/8 ring-2 ring-primary/70 ring-inset",
      )}
      onClick={onClick}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        listeners?.onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || event.target !== event.currentTarget) return;
        event.preventDefault();
        open();
      }}
    >
      <TaskCardContent task={task} archivable showProject={rowId === PRIORITY_ROW_ID} />
    </div>
  );
});

/**
 * What the DragOverlay renders while a card is lifted: it rises (scale and shadow) on pickup and
 * settles back while the drop animation lands it (`is-dropping`, see cardMotion).
 */
export function TaskCardOverlay({ task, showProject = false }: { task: TaskSummary; showProject?: boolean }) {
  // dnd-kit measures the overlay's first child to aim the drop, so the lift scale sits one level
  // deeper where it can't skew the landing spot.
  return (
    <div>
      <div
        className={cn(
          taskCardClassName(task, false),
          "scale-[1.03] cursor-grabbing bg-card shadow-xl transition-[scale,box-shadow] duration-200 ease-out motion-safe:animate-card-lift motion-reduce:transition-none",
          "in-[.is-dropping]:scale-100 in-[.is-dropping]:shadow-sm",
        )}
      >
        <TaskCardContent task={task} showProject={showProject} />
      </div>
    </div>
  );
}
