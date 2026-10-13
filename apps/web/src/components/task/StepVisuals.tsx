import type { StepStatus } from "@taskboard/contracts";
import { CheckIcon, CircleAlertIcon, CircleDotIcon, CircleIcon, CircleSlashIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/** Up to this many steps render as segments; longer plans use a continuous bar. */
const MAX_SEGMENTS = 12;

const SEGMENT_TONE: Record<StepStatus, string> = {
  done: "bg-success",
  skipped: "bg-success/45",
  in_progress: "bg-primary",
  blocked: "bg-warning",
  todo: "bg-muted-foreground/25",
};

/** T3 TaskSegments-style progress: one 3px pill per step, coloured by status. */
export function StepSegments({ statuses, className }: { statuses: ReadonlyArray<StepStatus>; className?: string }) {
  if (statuses.length === 0) return null;
  if (statuses.length > MAX_SEGMENTS) {
    const done = statuses.filter((s) => s === "done" || s === "skipped").length;
    return (
      <span aria-hidden className={cn("flex h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-muted-foreground/25", className)}>
        <span className="h-full rounded-full bg-success" style={{ width: `${(done / statuses.length) * 100}%` }} />
      </span>
    );
  }
  return (
    <span aria-hidden className={cn("flex w-10 shrink-0 items-center gap-0.5", className)}>
      {statuses.map((status, index) => (
        <span key={index} className={cn("h-[3px] min-w-0 flex-1 rounded-full", SEGMENT_TONE[status])} />
      ))}
    </span>
  );
}

/** Timeline node glyph for a step status (T3 task-list colour semantics). */
export function StepStatusGlyph({ status, size = "md" }: { status: StepStatus; size?: "sm" | "md" }) {
  const icon = size === "sm" ? "size-3.5" : "size-4";
  switch (status) {
    case "done":
      return (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full bg-success/16 text-success",
            size === "sm" ? "size-4" : "size-5",
          )}
        >
          <CheckIcon className={size === "sm" ? "size-2.5" : "size-3"} strokeWidth={3} />
        </span>
      );
    case "in_progress":
      return <CircleDotIcon className={cn(icon, "text-primary")} />;
    case "blocked":
      return <CircleAlertIcon className={cn(icon, "text-warning")} />;
    case "skipped":
      return <CircleSlashIcon className={cn(icon, "text-muted-foreground/40")} />;
    case "todo":
      return <CircleIcon className={cn(icon, "text-muted-foreground/40")} />;
  }
}

/** Step title colour per status (T3 ComposerTasksBadge semantics). */
export const STEP_TITLE_TONE: Record<StepStatus, string> = {
  done: "text-muted-foreground/55",
  in_progress: "text-foreground/90",
  todo: "text-muted-foreground/70",
  blocked: "text-foreground/90",
  skipped: "text-muted-foreground/55 line-through",
};
