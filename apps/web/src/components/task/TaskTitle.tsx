import type { Project, TaskDetail } from "@repo/contracts";
import { useState, type ReactNode } from "react";

import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useUpdateTask } from "~/state/mutations";
import { InlineInput } from "./InlineInput";

/** Click-to-edit title with the project chip and provenance underneath, and `actions` beside it. */
export function TaskTitle({
  task,
  project,
  actions,
}: {
  task: TaskDetail;
  project: Project | undefined;
  actions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const { mutate: updateTask } = useUpdateTask();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineInput
              ariaLabel="Task title"
              size="lg"
              value={task.title}
              onCommit={(title) => {
                setEditing(false);
                updateTask({ id: task.id, title });
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <h2 className="min-w-0">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="-mx-1 w-[calc(100%+0.5rem)] cursor-text rounded-md px-1 text-left text-lg leading-snug font-semibold text-foreground wrap-anywhere outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {task.title}
              </button>
            </h2>
          )}
        </div>
        {/* -my-1 centres the 32px buttons on the first title line without making the row taller;
            -me-1.5 lines the last icon up with the panel's content edge. */}
        {actions ? <div className="-my-1 -me-1.5 shrink-0">{actions}</div> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {project ? (
          <span className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-1.5 text-foreground/80">
            <ProjectFavicon title={project.title} icon={project.icon} />
            <span className="min-w-0 truncate">{project.title}</span>
          </span>
        ) : null}
        <span className="min-w-0 truncate">
          Created by {task.createdBy} · {formatRelativeTimeLabel(task.createdAt)}
        </span>
      </div>
    </div>
  );
}
