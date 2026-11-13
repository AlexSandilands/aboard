// Row styling adapted from T3 Code's SidebarThreadRow (Sidebar.tsx), MIT — see NOTICE.
import type { AttentionReason, Project, TaskSummary } from "@repo/contracts";
import { memo, useMemo, useState } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { SidebarGroup } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { AttentionIcon, ATTENTION_TONE } from "~/components/board/attention";
import { attentionLabel, attentionItems, topAttention, type AttentionItem } from "~/components/board/board.logic";
import { useOpenTask, useSelectedTaskId } from "~/components/board/boardNavigation";

/**
 * "Needs attention": every task with an attention reason, errors first, with tasks sharing a waiting or failed T3
 * thread (a bulk planning session) collapsed into one row. Hidden when empty.
 */
export function AttentionSection({
  tasks,
  projects,
}: {
  tasks: ReadonlyArray<TaskSummary>;
  projects: ReadonlyArray<Project>;
}) {
  const [expanded, setExpanded] = useState(true);
  const items = useMemo(() => attentionItems(tasks), [tasks]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const selectedTaskId = useSelectedTaskId();
  const openTask = useOpenTask();
  if (items.length === 0) return null;

  return (
    <SidebarGroup>
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={<span className="shrink-0 text-2xs tabular-nums">{items.length}</span>}
      >
        Needs attention
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul className="flex flex-col">
          {items.map((item) =>
            item.type === "thread" ? (
              <ThreadAttentionRow
                key={item.key}
                item={item}
                project={projectById.get(item.tasks[0]!.projectId) ?? null}
                selectedTaskId={selectedTaskId}
                onOpen={openTask}
              />
            ) : (
              <AttentionRow
                key={item.key}
                task={item.task}
                reasons={item.reasons}
                project={projectById.get(item.task.projectId) ?? null}
                selected={item.task.id === selectedTaskId}
                onOpen={openTask}
              />
            ),
          )}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}

const AttentionRow = memo(function AttentionRow({
  task,
  reasons,
  project,
  selected,
  onOpen,
}: {
  task: TaskSummary;
  reasons: ReadonlyArray<AttentionReason>;
  project: Project | null;
  selected: boolean;
  onOpen: (taskId: string) => unknown;
}) {
  const reason = topAttention(reasons);
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
              {attentionLabel(reason)}
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

type ThreadItem = Extract<AttentionItem, { type: "thread" }>;

/** One waiting or failed thread shared by several tasks: the row opens the first, each number opens its own. */
const ThreadAttentionRow = memo(function ThreadAttentionRow({
  item,
  project,
  selectedTaskId,
  onOpen,
}: {
  item: ThreadItem;
  project: Project | null;
  selectedTaskId: string | null;
  onOpen: (taskId: string) => unknown;
}) {
  const { reason, tasks } = item;
  const first = tasks[0]!;
  const selected = tasks.some((task) => task.id === selectedTaskId);
  return (
    <li className="list-none py-0.5 [contain-intrinsic-size:auto_78px] [content-visibility:auto]">
      <div
        role="button"
        tabIndex={0}
        aria-current={selected || undefined}
        aria-label={`${item.title}, ${tasks.map((t) => `#${t.number}`).join(", ")}: ${reason.message}`}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={() => onOpen(first.id)}
        onKeyDown={(event) => {
          // Keys on a task number belong to that button.
          if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onOpen(first.id);
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
              {attentionLabel(reason)}
            </span>
          </div>
          <div className="mt-1 flex min-w-0">
            <span
              className={cn(
                "truncate text-sm group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                selected ? "text-foreground" : "text-secondary-label/90",
              )}
            >
              {item.title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="flex min-w-0 flex-1 gap-1.5 overflow-hidden font-mono text-muted-foreground/70">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  title={task.title}
                  className="shrink-0 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(task.id);
                  }}
                >
                  #{task.number}
                </button>
              ))}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
});
