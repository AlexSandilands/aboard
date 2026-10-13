// Row styling adapted from T3 Code's SidebarThreadRow (Sidebar.tsx), MIT — see NOTICE.
import type { Project, TaskSummary } from "@repo/contracts";
import { memo, useMemo, useState } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { SidebarGroup } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { AttentionIcon, ATTENTION_TONE } from "~/components/board/attention";
import { ATTENTION_LABELS, attentionTasks, topAttention } from "~/components/board/board.logic";
import { useOpenTask, useSelectedTaskId } from "~/components/board/boardNavigation";

/** "Needs attention": every task with an attention reason, errors first. Hidden when empty. */
export function AttentionSection({
  tasks,
  projects,
}: {
  tasks: ReadonlyArray<TaskSummary>;
  projects: ReadonlyArray<Project>;
}) {
  const [expanded, setExpanded] = useState(true);
  const flagged = useMemo(() => attentionTasks(tasks), [tasks]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const selectedTaskId = useSelectedTaskId();
  const openTask = useOpenTask();
  if (flagged.length === 0) return null;

  return (
    <SidebarGroup>
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={<span className="shrink-0 text-2xs tabular-nums">{flagged.length}</span>}
      >
        Needs attention
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul className="flex flex-col">
          {flagged.map((task) => (
            <AttentionRow
              key={task.id}
              task={task}
              project={projectById.get(task.projectId) ?? null}
              selected={task.id === selectedTaskId}
              onOpen={openTask}
            />
          ))}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}

const AttentionRow = memo(function AttentionRow({
  task,
  project,
  selected,
  onOpen,
}: {
  task: TaskSummary;
  project: Project | null;
  selected: boolean;
  onOpen: (taskId: string) => unknown;
}) {
  const reason = topAttention(task.attention);
  if (!reason) return null;
  return (
    <li className="list-none py-0.5 [contain-intrinsic-size:auto_78px] [content-visibility:auto]">
      <div
        role="button"
        tabIndex={0}
        aria-current={selected || undefined}
        aria-label={`#${task.number} ${task.title}: ${reason.message}`}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={() => onOpen(task.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen(task.id);
        }}
      >
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {project ? <ProjectFavicon title={project.title} icon={project.icon} className="size-4 shrink-0" /> : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {project?.title ?? ""}
            </span>
            <span
              className={cn(
                "ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium",
                ATTENTION_TONE[reason.severity],
              )}
            >
              <AttentionIcon severity={reason.severity} className="size-4" />
              {ATTENTION_LABELS[reason.kind]}
            </span>
          </div>
          <div className="mt-1 flex min-w-0">
            <span
              className={cn(
                "truncate text-sm group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                selected ? "text-foreground" : "text-secondary-label/90",
              )}
            >
              <span className="font-mono text-muted-foreground/70">#{task.number}</span> {task.title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{reason.message}</span>
          </div>
        </div>
      </div>
    </li>
  );
});
