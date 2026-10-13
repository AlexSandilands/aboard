import type { StepStatus, TaskSummary } from "@repo/contracts";
import { cn } from "~/lib/utils";

// Adapted from T3 Code's TaskSegments (ComposerTasksBadge.tsx), MIT — see NOTICE.
const MAX_SEGMENTS = 12;

const SEGMENT_TONE: Record<StepStatus, string> = {
  done: "bg-success",
  in_progress: "bg-primary",
  blocked: "bg-warning",
  skipped: "bg-muted-foreground/40",
  todo: "bg-muted-foreground/25",
};

/** Per-step segments for short plans, one continuous done-fraction bar for long ones. */
export function TaskSegments({
  steps,
  done,
  total,
}: {
  steps: ReadonlyArray<StepStatus>;
  done: number;
  total: number;
}) {
  if (steps.length > MAX_SEGMENTS) {
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
      <span
        aria-hidden
        className="relative flex h-[3px] w-16 shrink-0 overflow-hidden rounded-full bg-muted-foreground/25"
      >
        <span className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
      </span>
    );
  }
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center gap-0.5", steps.length > 6 ? "w-16" : "w-10")}>
      {steps.map((status, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- segments are positional; a step's index is its identity here
        <span key={index} className={cn("h-[3px] min-w-0 flex-1 rounded-full", SEGMENT_TONE[status])} />
      ))}
    </span>
  );
}

/** Card line 3: segments, `done/total` and the current step, or a hint that an idea has no plan. */
export function TaskProgressLine({ task }: { task: TaskSummary }) {
  if (task.progress.total === 0) {
    return task.status === "idea" ? <div className="text-xs text-muted-foreground/60">No plan yet</div> : null;
  }
  return (
    <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs">
      <TaskSegments steps={task.stepStatuses} done={task.progress.done} total={task.progress.total} />
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {task.progress.done}/{task.progress.total}
      </span>
      {task.currentStep ? (
        <span
          className="min-w-0 flex-1 truncate text-secondary-label"
          title={`${task.currentStep.phaseTitle} › ${task.currentStep.title}`}
        >
          {task.currentStep.title}
        </span>
      ) : null}
    </div>
  );
}
