import { describeEpicRollup, type TaskSummary } from "@repo/contracts";
import { ChevronRightIcon, GroupIcon } from "lucide-react";
import { memo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useBoardContext } from "./BoardContext";
import { EpicRollupBar } from "./EpicRollupBar";
import { ArchiveButton } from "./TaskCard";

/**
 * A finished epic in the Done column: the band's header as one card, so a run of finished epics doesn't push
 * the rest of Done down. Its tasks are inside, folded until the chevron opens them. It can't be dragged (an
 * epic has no status of its own), and has no Autopilot button, since a finished epic has nothing to run.
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
      className={cn(
        "w-full rounded-xl border border-border/60 bg-muted/25",
        selected && "border-primary/50 ring-1 ring-primary/30",
        epic.archivedAt && "opacity-60",
      )}
    >
      <div className="flex items-center gap-1 py-2 ps-1 pe-2.5">
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
        {epic.archivedAt ? null : <ArchiveButton task={epic} />}
      </div>
      {open ? (
        <ul className="flex flex-col gap-0.5 border-t border-border/40 p-1">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
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
