import { describeEpicRollup, TASK_STATUSES, type TaskDetail, type TaskSummary } from "@repo/contracts";
import { FilterIcon, PlusIcon } from "lucide-react";

import { AttentionIcon } from "~/components/board/attention";
import { topAttention } from "~/components/board/board.logic";
import { THREAD_STATUS } from "~/components/board/CardLinks";
import { useOpenTask } from "~/components/board/boardNavigation";
import { EpicRollupBar } from "~/components/board/EpicRollupBar";
import { TaskSegments } from "~/components/board/TaskProgress";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { usePalette } from "~/state/ui";
import { epicChildGroups } from "./epic.logic";

/**
 * An epic's panel shows this where a task shows where it's up to: the roll-up, then each child grouped by
 * status with its progress, current step, attention and live thread status.
 */
export function EpicChildren({ task, onFilter }: { task: TaskDetail; onFilter: () => void }) {
  const openTask = useOpenTask();
  const rollup = task.rollup;
  const groups = epicChildGroups(task.children);
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground/90">Tasks</span>
        {rollup ? <EpicRollupBar rollup={rollup} className="w-24" /> : null}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {rollup ? describeEpicRollup(rollup) : null}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {task.children.length > 0 ? (
            <Button variant="ghost-muted" size="xs" onClick={onFilter}>
              <FilterIcon />
              Show on board
            </Button>
          ) : null}
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() =>
              usePalette.getState().openPalette({ kind: "new-task", projectId: task.projectId, epicId: task.id })
            }
          >
            <PlusIcon />
            Add task
          </Button>
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No tasks yet. Add one here, or set a task&apos;s epic from its panel or over MCP.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {groups.map(({ status, tasks }) => (
            <section key={status} aria-label={STATUS_LABEL[status]}>
              <h3 className="mb-0.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                {STATUS_LABEL[status]} <span className="tabular-nums text-muted-foreground/70">{tasks.length}</span>
              </h3>
              <ul className="flex flex-col">
                {tasks.map((child) => (
                  <li key={child.id}>
                    <ChildRow task={child} onOpen={() => void openTask(child.id)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<
  TaskSummary["status"],
  string
>;

function ChildRow({ task, onOpen }: { task: TaskSummary; onOpen: () => void }) {
  const attention = topAttention(task.attention);
  const threads = task.links.flatMap((l) => (l.kind === "t3_thread" && l.snapshot ? [l.snapshot] : []));
  const thread = threads.find((t) => !t.settled && !t.archived) ?? null;
  const threadStatus = thread ? THREAD_STATUS[thread.status] : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 flex-col gap-0.5 rounded-md px-1 py-1 text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        task.archivedAt && "opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{task.number}</span>
        <span className="min-w-0 truncate text-foreground/90">{task.title}</span>
        {attention ? (
          <span className="flex shrink-0 items-center" title={attention.message}>
            <AttentionIcon severity={attention.severity} className="size-3.5" />
          </span>
        ) : null}
        {threadStatus ? (
          <span className="ms-auto flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 rounded-full", threadStatus.dot)} />
            {threadStatus.label}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {task.progress.total > 0 ? (
          <>
            <TaskSegments steps={task.stepStatuses} done={task.progress.done} total={task.progress.total} />
            <span className="shrink-0 tabular-nums">
              {task.progress.done}/{task.progress.total}
            </span>
            {task.currentStep ? <span className="min-w-0 truncate">{task.currentStep.title}</span> : null}
          </>
        ) : task.resolution ? (
          <span>Closed</span>
        ) : (
          <span className="text-muted-foreground/70">No plan yet</span>
        )}
      </span>
    </button>
  );
}
