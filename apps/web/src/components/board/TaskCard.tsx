import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TaskSummary } from "@repo/contracts";
import { memo, type KeyboardEvent } from "react";
import { Badge } from "~/components/ui/badge";
import { resolutionLabel } from "~/components/task/resolution.logic";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { AttentionIcon } from "./attention";
import { ATTENTION_LABELS, jiraKeys, topAttention } from "./board.logic";
import { useBoardContext } from "./BoardContext";
import { CardLinks, chipClassName, hasCardLinks, linkHandlers } from "./CardLinks";
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
export const TaskCardContent = memo(function TaskCardContent({ task }: { task: TaskSummary }) {
  const attention = topAttention(task.attention);
  const jiraKey = jiraKeys(task)[0];
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">#{task.number}</span>
        {jiraKey ? (
          <Badge variant="outline" size="sm">
            {jiraKey}
          </Badge>
        ) : null}
        <ResolutionChip task={task} />
        {task.archivedAt ? (
          <Badge variant="secondary" size="sm">
            Archived
          </Badge>
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
      </div>
      <p className="line-clamp-2 text-sm font-medium text-foreground/90 [overflow-wrap:anywhere]">{task.title}</p>
      <TaskProgressLine task={task} />
      {hasCardLinks(task.links) ? <CardLinks links={task.links} /> : null}
    </div>
  );
});

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

/** A draggable card in a board cell. Click or Enter opens the detail panel; Space picks it up. */
export const SortableTaskCard = memo(function SortableTaskCard({
  task,
  selected,
}: {
  task: TaskSummary;
  selected: boolean;
}) {
  const { openTask, suppressClickRef } = useBoardContext();
  const data: DragData = { type: "task", projectId: task.projectId, status: task.status };
  // Archived cards (Show archived) open in the panel but can't be dragged; unarchive first.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data,
    disabled: !!task.archivedAt,
  });

  const open = () => {
    if (suppressClickRef.current) return;
    openTask(task.id);
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      // Restates dnd-kit's defaults so the card's semantics are visible statically.
      role="button"
      tabIndex={0}
      aria-label={`#${task.number} ${task.title}`}
      aria-current={selected || undefined}
      data-task-card={task.id}
      className={cn(
        taskCardClassName(task, selected),
        "[contain-intrinsic-size:auto_84px] [content-visibility:auto]",
        isDragging && "opacity-40",
      )}
      onClick={open}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        listeners?.onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || event.target !== event.currentTarget) return;
        event.preventDefault();
        open();
      }}
    >
      <TaskCardContent task={task} />
    </div>
  );
});

/** What the DragOverlay renders while a card is lifted. Static tilt, no animation. */
export function TaskCardOverlay({ task }: { task: TaskSummary }) {
  return (
    <div className={cn(taskCardClassName(task, false), "rotate-[1deg] cursor-grabbing bg-card shadow-lg")}>
      <TaskCardContent task={task} />
    </div>
  );
}
