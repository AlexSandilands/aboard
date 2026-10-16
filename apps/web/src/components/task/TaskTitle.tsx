import type { Project, TaskDetail } from "@repo/contracts";
import { useState, type ReactNode } from "react";

import { GroupIcon } from "lucide-react";
import { useOpenTask } from "~/components/board/boardNavigation";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useUpdateTask } from "~/state/mutations";
import { InlineInput } from "./InlineInput";

/** Click-to-edit title with the project (and epic) chips and provenance underneath, and `actions` beside the title or, on narrow panels, the meta row. */
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
  const openTask = useOpenTask();
  // One grid, two layouts: actions sit beside the title when the panel (the @container) has room,
  // otherwise on the meta row so a wrapping title keeps the full width.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
      <div className="col-span-2 min-w-0 @min-[460px]:col-span-1">
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
      {/* -my-1 centres the 32px buttons on the 24px line beside them without making the row taller;
          -me-1.5 lines the last icon up with the panel's content edge. */}
      {actions ? (
        <div className="col-start-2 row-start-2 -my-1 -me-1.5 self-center @min-[460px]:row-start-1 @min-[460px]:self-start">
          {actions}
        </div>
      ) : null}
      <div className="col-start-1 row-start-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground @min-[460px]:col-span-2">
        {project ? (
          // The chip names the project, so the provenance text gives way first when actions share the row.
          <span className="inline-flex h-6 max-w-[60%] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-1.5 text-foreground/80">
            <ProjectFavicon title={project.title} icon={project.icon} />
            <span className="min-w-0 truncate">{project.title}</span>
          </span>
        ) : null}
        {task.parent ? (
          <button
            type="button"
            title={`In epic #${task.parent.number} ${task.parent.title}`}
            onClick={() => void openTask(task.parent!.id)}
            className="inline-flex h-6 max-w-[40%] min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-1.5 text-foreground/80 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GroupIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 tabular-nums text-muted-foreground">#{task.parent.number}</span>
            <span className="min-w-0 truncate">{task.parent.title}</span>
          </button>
        ) : null}
        <span className="min-w-0 truncate">
          Created by {task.createdBy} · {formatRelativeTimeLabel(task.createdAt)}
        </span>
      </div>
    </div>
  );
}
