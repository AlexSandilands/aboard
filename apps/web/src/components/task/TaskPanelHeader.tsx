import { TASK_STATUSES, type Project, type TaskDetail, type TaskStatus } from "@repo/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  EllipsisIcon,
  FolderInputIcon,
  HashIcon,
  LinkIcon,
  ListTodoIcon,
  XIcon,
} from "lucide-react";

import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isPlanRequired, useMoveTask, useUpdateTask } from "~/state/mutations";
import { copyToClipboard } from "./InlineInput";

const STATUS_ITEMS = TASK_STATUSES.map((s) => ({ value: s.value, label: s.label }));

export function TaskPanelHeader({
  task,
  projects,
  onClose,
  onOpenPlanEditor,
}: {
  task: TaskDetail;
  projects: ReadonlyArray<Project>;
  onClose: () => void;
  onOpenPlanEditor: () => void;
}) {
  const { mutate: moveTask } = useMoveTask();
  const { mutate: updateTask } = useUpdateTask();
  const hasPlan = task.progress.total > 0;
  const archived = task.archivedAt !== null;

  const setStatus = (status: TaskStatus) => {
    if (status === task.status) return;
    moveTask({ id: task.id, status }, { onError: (error) => isPlanRequired(error) && onOpenPlanEditor() });
  };

  const copyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("task", task.id);
    copyToClipboard(url.toString(), "link");
  };

  return (
    <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border px-3">
      <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{task.number}</span>
      <Select
        value={task.status}
        items={STATUS_ITEMS}
        onValueChange={(value) => {
          if (value) setStatus(value);
        }}
      >
        <SelectTrigger variant="ghost" size="xs" aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
          {STATUS_ITEMS.map((status) => {
            const gated = !hasPlan && status.value !== "idea";
            return (
              <SelectItem key={status.value} value={status.value} disabled={gated}>
                {status.label}
                {gated ? <span className="text-muted-foreground"> · needs a plan</span> : null}
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      {archived ? (
        <Badge variant="warning" size="sm">
          Archived
        </Badge>
      ) : null}

      <div className="ms-auto flex items-center gap-0.5">
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Task actions" />}>
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onOpenPlanEditor}>
              <ListTodoIcon />
              {hasPlan ? "Edit plan" : "Write plan"}
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <FolderInputIcon />
                Move to project
              </MenuSubTrigger>
              <MenuSubPopup>
                {projects
                  .filter((p) => p.archivedAt === null || p.id === task.projectId)
                  .map((project) => (
                    <MenuItem
                      key={project.id}
                      disabled={project.id === task.projectId}
                      onClick={() => updateTask({ id: task.id, projectId: project.id })}
                    >
                      <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />
                      <MenuItemLabel>{project.title}</MenuItemLabel>
                      {project.id === task.projectId ? <CheckIcon className="ms-auto size-3.5" /> : null}
                    </MenuItem>
                  ))}
              </MenuSubPopup>
            </MenuSub>
            <MenuItem onClick={() => updateTask({ id: task.id, archived: !archived })}>
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? "Unarchive" : "Archive"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={copyLink}>
              <LinkIcon />
              Copy link
            </MenuItem>
            <MenuItem onClick={() => copyToClipboard(`#${task.number}`, "task reference")}>
              <HashIcon />
              Copy task reference
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Close panel" onClick={onClose} />}>
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
        </Tooltip>
      </div>
    </header>
  );
}
