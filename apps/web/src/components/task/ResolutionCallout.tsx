import type { TaskDetail, TaskRef } from "@repo/contracts";
import { CircleCheckBigIcon, CopyIcon, XCircleIcon } from "lucide-react";

import { useOpenTask } from "~/components/board/boardNavigation";
import { resolutionLabel } from "./resolution.logic";

/** Why a closed task is closed, and which tasks this one also resolved. Renders nothing when neither applies. */
export function ResolutionCallout({ task }: { task: TaskDetail }) {
  const label = resolutionLabel(task);
  if (!label && task.resolves.length === 0) return null;
  const Icon =
    task.resolution === "wont_do" ? XCircleIcon : task.resolution === "duplicate" ? CopyIcon : CircleCheckBigIcon;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-card/40 p-3 text-sm">
      {label ? (
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-semibold text-foreground/90">Closed</span>
          <span className="shrink-0 text-muted-foreground">·</span>
          {task.resolvedBy ? (
            <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
              <span className="shrink-0">{task.resolution === "duplicate" ? "duplicate of" : "done by"}</span>
              <TaskRefButton task={task.resolvedBy} />
            </span>
          ) : (
            <span className="text-muted-foreground">{label.toLowerCase()}</span>
          )}
        </div>
      ) : null}
      {task.resolves.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <span className="shrink-0">Also resolved</span>
          {task.resolves.map((resolved) => (
            <span key={resolved.id} className="flex min-w-0 items-center gap-1">
              <TaskRefButton task={resolved} />
              {resolved.resolution === "duplicate" ? <span className="text-xs">(duplicate)</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskRefButton({ task }: { task: TaskRef }) {
  const openTask = useOpenTask();
  return (
    <button
      type="button"
      onClick={() => void openTask(task.id)}
      className="flex min-w-0 items-center gap-1 rounded-sm text-foreground/90 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="shrink-0 font-mono text-xs tabular-nums">#{task.number}</span>
      <span className="min-w-0 truncate">{task.title}</span>
    </button>
  );
}
