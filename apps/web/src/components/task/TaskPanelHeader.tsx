import { TASK_STATUSES, type Project, type TaskDetail, type TaskStatus } from "@repo/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CircleCheckBigIcon,
  CopyIcon,
  EllipsisIcon,
  FolderInputIcon,
  HashIcon,
  LinkIcon,
  ListTodoIcon,
  RotateCcwIcon,
  SquareCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

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
import { isPlanRequired, useDeleteTask, useMoveTask, useResolveTask, useUpdateTask } from "~/state/mutations";
import { CloseTaskDialog, type PickResolution } from "./CloseTaskDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { copyToClipboard } from "./InlineInput";
import { resolutionLabel } from "./resolution.logic";

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
  const { mutate: resolveTask } = useResolveTask();
  const { mutate: deleteTask } = useDeleteTask();
  const [closeAs, setCloseAs] = useState<PickResolution | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const resolution = resolutionLabel(task);
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
    <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border px-3 wco:pe-(--workspace-native-controls-inset)">
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
      {resolution ? (
        <Badge variant="secondary" size="sm">
          {resolution}
        </Badge>
      ) : null}
      {archived ? (
        <Badge variant="warning" size="sm">
          Archived
        </Badge>
      ) : null}

      <div className="ms-auto flex items-center gap-0.5">
        {task.status === "done" && !archived ? (
          <Button variant="outline" size="xs" onClick={() => updateTask({ id: task.id, archived: true })}>
            <ArchiveIcon />
            Archive
          </Button>
        ) : null}
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
            {task.resolution ? (
              // Back to where a plan allows: a planless task can only be an idea.
              <MenuItem onClick={() => setStatus(hasPlan ? "planned" : "idea")}>
                <RotateCcwIcon />
                Reopen
              </MenuItem>
            ) : null}
            <MenuSub>
              <MenuSubTrigger>
                <CircleCheckBigIcon />
                {task.resolution ? "Close differently" : "Close as…"}
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem onClick={() => setCloseAs("completed")}>
                  <SquareCheckIcon />
                  Done by another task…
                </MenuItem>
                <MenuItem onClick={() => setCloseAs("duplicate")}>
                  <CopyIcon />
                  Duplicate of…
                </MenuItem>
                <MenuItem
                  disabled={task.resolution === "wont_do"}
                  onClick={() => resolveTask({ id: task.id, resolution: "wont_do" })}
                >
                  <XIcon />
                  Won&apos;t do
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
            <MenuItem onClick={() => updateTask({ id: task.id, archived: !archived })}>
              {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {archived ? "Unarchive" : "Archive"}
            </MenuItem>
            {archived ? (
              // Deleting is a second step after archiving, so it never sits next to everyday actions.
              <MenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2Icon />
                Delete permanently…
              </MenuItem>
            ) : null}
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
      <CloseTaskDialog task={task} resolution={closeAs} onOpenChange={(open) => !open && setCloseAs(null)} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete #${task.number}?`}
        description="This permanently deletes the task with its plan, links and activity. It can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          // Close up front: task.deleted can arrive before the response and flash "Task not found".
          // Failures still toast, since the hook's onError outlives the panel.
          deleteTask(task.id);
          onClose();
        }}
      />
    </header>
  );
}
