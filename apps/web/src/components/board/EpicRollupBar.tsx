import { ROLLUP_ORDER, type EpicRollup, type TaskStatus } from "@repo/contracts";
import { cn } from "~/lib/utils";

const ROLLUP_TONE: Record<TaskStatus, string> = {
  done: "bg-success",
  review: "bg-info",
  in_progress: "bg-primary",
  planned: "bg-muted-foreground/45",
  backlog: "bg-muted-foreground/20",
};

/** The epic's children as one bar, a segment per status. */
export function EpicRollupBar({ rollup, className }: { rollup: EpicRollup; className?: string }) {
  if (rollup.total === 0) {
    return <span aria-hidden className={cn("h-1 rounded-full bg-muted-foreground/15", className)} />;
  }
  return (
    <span aria-hidden className={cn("flex h-1 overflow-hidden rounded-full bg-muted-foreground/15", className)}>
      {ROLLUP_ORDER.map((status) =>
        rollup.byStatus[status] > 0 ? (
          <span
            key={status}
            className={ROLLUP_TONE[status]}
            style={{ width: `${(rollup.byStatus[status] / rollup.total) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
}
