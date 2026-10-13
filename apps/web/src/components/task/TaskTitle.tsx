import type { Project, TaskDetail } from "@repo/contracts";
import { useState } from "react";

import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useUpdateTask } from "~/state/mutations";
import { InlineInput } from "./InlineInput";

/** Click-to-edit title with the project chip and provenance underneath. */
export function TaskTitle({ task, project }: { task: TaskDetail; project: Project | undefined }) {
  const [editing, setEditing] = useState(false);
  const { mutate: updateTask } = useUpdateTask();
  return (
    <div className="flex flex-col gap-2">
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
