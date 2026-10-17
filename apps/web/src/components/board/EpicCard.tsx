import { describeEpicRollup, type TaskSummary } from "@repo/contracts";
import { ChevronRightIcon, GroupIcon } from "lucide-react";
import { memo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useBoardContext } from "./BoardContext";
import { EpicActions } from "./EpicActions";
import { EpicRollupBar } from "./EpicRollupBar";
import {
  EPIC_ACCENT_BAR,
  EPIC_ACCENT_CLASS,
  EPIC_FRAME_CLASS,
  EPIC_HEADER_CLASS,
  epicAccentStyle,
} from "./epicStyle.logic";
import { ArchiveButton } from "./TaskCard";

/**
 * A finished epic in the Done column: the band's header as one card, so a run of finished epics doesn't push
 * the rest of Done down. Its tasks are inside, folded until the chevron opens them. It can't be dragged (an
 * epic has no status of its own), and has no Autopilot button, since a finished epic has nothing to run. Its
 * threads, sessions and start button are the band header's.
 */
export const EpicCard = memo(function EpicCard({
  epic,
  tasks,
  selectedTaskId,
}: {
  epic: TaskSummary;
  /** The epic's tasks, shown when the card is open. */
  tasks: ReadonlyArray<TaskSummary>;
  selectedTaskId: string | null;
}) {
  const { openTask } = useBoardContext();
  const rollup = epic.rollup ?? {
    total: 0,
    done: 0,
    byStatus: { backlog: 0, planned: 0, in_progress: 0, review: 0, done: 0 },
  };
  const selected = selectedTaskId === epic.id;
  const hasSelectedTask = tasks.some((task) => task.id === selectedTaskId);
  const [open, setOpen] = useState(hasSelectedTask);
  // Opening a task of the epic (a link, the URL) shows it in the card, but the chevron still folds it after.
  const [hadSelectedTask, setHadSelectedTask] = useState(hasSelectedTask);
  if (hasSelectedTask !== hadSelectedTask) {
    setHadSelectedTask(hasSelectedTask);
    if (hasSelectedTask) setOpen(true);
  }

  return (
    <section
      aria-label={`Epic #${epic.number} ${epic.title}`}
      data-epic-card={epic.id}
      style={EPIC_ACCENT_BAR ? epicAccentStyle(epic.title) : undefined}
      className={cn(
        "w-full",
        EPIC_FRAME_CLASS,
        EPIC_ACCENT_BAR && EPIC_ACCENT_CLASS,
        selected && "border-primary/50 ring-1 ring-primary/30",
        epic.archivedAt && "opacity-60",
      )}
    >
      <div
        // The marker the dependency lines look for: they end on the header, not the whole card with its tasks.
        data-task-card={epic.id}
        className={cn("flex items-center gap-1 py-2 ps-1 pe-2.5", EPIC_HEADER_CLASS, !open && "rounded-b-xl")}
      >
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-expanded={open}
          aria-label={open ? `Hide the tasks of epic #${epic.number}` : `Show the tasks of epic #${epic.number}`}
          onClick={() => setOpen(!open)}
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-current={selected || undefined}
          title={describeEpicRollup(rollup)}
          onClick={() => openTask(epic.id)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <GroupIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{epic.number}</span>
            <span className="min-w-0 truncate text-sm font-medium text-foreground/90">{epic.title}</span>
            {epic.archivedAt ? (
              <Badge variant="secondary" size="sm">
                Archived
              </Badge>
            ) : null}
          </span>
          <span className="flex items-center gap-1.5">
            <EpicRollupBar rollup={rollup} className="min-w-0 flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {rollup.done}/{rollup.total} done
            </span>
          </span>
        </button>
        <EpicActions epic={epic} />
        {epic.archivedAt ? null : <ArchiveButton task={epic} />}
      </div>
      {open ? (
        <ul className="flex flex-col gap-0.5 border-t border-border/40 p-1">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                // Lets dependency lines find the task inside the card.
                data-task-card={task.id}
                className={cn(
                  "flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-2 py-1 text-start text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  task.id === selectedTaskId ? "bg-sidebar-row-selected" : "hover:bg-accent/40",
                  task.archivedAt && "opacity-60",
                )}
                aria-current={task.id === selectedTaskId || undefined}
                onClick={() => openTask(task.id)}
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">#{task.number}</span>
                <span className="min-w-0 truncate text-foreground/90">{task.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
});
