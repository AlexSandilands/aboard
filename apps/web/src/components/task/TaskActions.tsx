import { BRAND, type Project, type TaskDetail } from "@repo/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CircleCheckBigIcon,
  CopyIcon,
  EllipsisIcon,
  FolderInputIcon,
  GroupIcon,
  HashIcon,
  LinkIcon,
  ListTodoIcon,
  PinIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareCheckIcon,
  Trash2Icon,
  FilePlus2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type SyntheticEvent } from "react";

import { ProjectFavicon } from "~/components/project/ProjectFavicon";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { canStartT3Thread, showHandoffActions } from "~/components/handoff/handoff.logic";
import { copyTaskReference, HandoffMenu } from "~/components/handoff/HandoffActions";
import { cn } from "~/lib/utils";
import { useDeleteTask, useResolveTask, useUpdateTask } from "~/state/mutations";
import { useBoard, useSettings } from "~/state/queries";
import { draftFromTask } from "~/components/templates/templates.logic";
import { useDialogs, usePalette, useTaskPanelPrefs } from "~/state/ui";
import { epicOptions } from "./epic.logic";
import { CloseTaskDialog, type PickResolution } from "./CloseTaskDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { copyToClipboard } from "./InlineInput";
import { menuActions, normalizePins, pinnedButtons, type PinnableAction } from "./taskActions.logic";
import { useSetTaskStatus } from "./useSetTaskStatus";

interface ActionDef {
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** Hand-off buttons, pinned actions and the More menu, shown beside the task title. */
export function TaskActions({
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
  const { mutate: updateTask } = useUpdateTask();
  const { mutate: resolveTask } = useResolveTask();
  const { mutate: deleteTask } = useDeleteTask();
  const setStatus = useSetTaskStatus(task, onOpenPlanEditor);
  const storedPins = useTaskPanelPrefs((s) => s.pinnedActions);
  const togglePinnedAction = useTaskPanelPrefs((s) => s.togglePinnedAction);
  const [closeAs, setCloseAs] = useState<PickResolution | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hasPlan = task.progress.total > 0;
  const archived = task.archivedAt !== null;
  const board = useBoard().data;
  const t3 = board?.integrations.t3;
  const epics = epicOptions(board?.tasks ?? [], task);
  const settings = useSettings().data;
  const taskProject = projects.find((p) => p.id === task.projectId);
  const handoff = showHandoffActions(task);
  const startT3 = handoff && !!t3 && canStartT3Thread(task, taskProject, t3, settings);

  const actions: Record<PinnableAction, ActionDef> = {
    plan: { label: hasPlan ? "Edit plan" : "Write plan", icon: ListTodoIcon, run: onOpenPlanEditor },
    // Back to where a plan allows: a planless task can only be in Backlog.
    reopen: { label: "Reopen", icon: RotateCcwIcon, run: () => setStatus(hasPlan ? "planned" : "backlog") },
    archive: {
      label: archived ? "Unarchive" : "Archive",
      icon: archived ? ArchiveRestoreIcon : ArchiveIcon,
      run: () => updateTask({ id: task.id, archived: !archived }),
    },
    "copy-link": {
      label: "Copy link",
      icon: LinkIcon,
      run: () => {
        const url = new URL(window.location.href);
        url.searchParams.set("task", task.id);
        copyToClipboard(url.toString(), "link");
      },
    },
    "copy-reference": {
      label: `Copy ${BRAND.id} link`,
      icon: HashIcon,
      run: () => copyTaskReference(task),
    },
  };
  const pins = normalizePins(storedPins);
  const menu = menuActions(task);
  const item = (id: PinnableAction) =>
    menu.includes(id) ? (
      <PinnableMenuItem action={actions[id]} pinned={pins.includes(id)} onTogglePin={() => togglePinnedAction(id)} />
    ) : null;

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {pinnedButtons(pins, task).map((id) => (
        <PinnedButton key={id} action={actions[id]} />
      ))}
      {handoff ? <HandoffMenu task={task} variant="panel" canStartT3={startT3} /> : null}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={<MenuTrigger render={<Button variant="ghost" size="icon" aria-label="More actions" />} />}
          >
            <EllipsisIcon />
          </TooltipTrigger>
          <TooltipPopup>More actions</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          {item("plan")}
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
          {task.kind === "epic" ? null : (
            <MenuSub>
              <MenuSubTrigger>
                <GroupIcon />
                Epic
              </MenuSubTrigger>
              <MenuSubPopup>
                {epics.map((epic) => (
                  <MenuItem
                    key={epic.id}
                    disabled={epic.id === task.parent?.id}
                    onClick={() => updateTask({ id: task.id, epicId: epic.id })}
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground">#{epic.number}</span>
                    <MenuItemLabel>{epic.title}</MenuItemLabel>
                    {epic.id === task.parent?.id ? <CheckIcon className="ms-auto size-3.5" /> : null}
                  </MenuItem>
                ))}
                {epics.length ? <MenuSeparator /> : null}
                <MenuItem disabled={!task.parent} onClick={() => updateTask({ id: task.id, epicId: null })}>
                  <XIcon />
                  No epic
                </MenuItem>
                <MenuItem
                  onClick={() => usePalette.getState().openPalette({ kind: "new-epic", projectId: task.projectId })}
                >
                  <PlusIcon />
                  New epic…
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          )}
          {item("reopen")}
          {task.kind === "epic" ? null : (
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
          )}
          {task.kind === "epic" ? null : (
            <MenuItem onClick={() => useDialogs.getState().openTemplateDraft(draftFromTask(task))}>
              <FilePlus2Icon />
              Save as template…
            </MenuItem>
          )}
          {item("archive")}
          {archived ? (
            // Deleting is a second step after archiving, so it never sits next to everyday actions.
            <MenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon />
              Delete permanently…
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {item("copy-link")}
          {item("copy-reference")}
        </MenuPopup>
      </Menu>
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
    </div>
  );
}

function PinnedButton({ action }: { action: ActionDef }) {
  const Icon = action.icon;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={action.label} onClick={action.run} />}>
        <Icon />
      </TooltipTrigger>
      <TooltipPopup>{action.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Keeps a pin toggle from activating (and closing) the menu item around it. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

function PinnableMenuItem({
  action,
  pinned,
  onTogglePin,
}: {
  action: ActionDef;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const Icon = action.icon;
  return (
    <MenuItem className="group/item" onClick={action.run}>
      <Icon />
      <MenuItemLabel>{action.label}</MenuItemLabel>
      {/* Pointer-only shortcut: the action itself stays reachable here, so the menu keeps its
          single-stop keyboard model rather than nesting a focusable control in each item. */}
      <span
        aria-hidden
        title={pinned ? "Unpin from the title row" : "Pin to the title row"}
        onClick={(event) => {
          stop(event);
          onTogglePin();
        }}
        onMouseUp={stop}
        className={cn(
          "ms-auto -me-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-foreground/10 hover:text-foreground",
          pinned
            ? "text-foreground/80"
            : "opacity-0 group-hover/item:opacity-100 group-data-highlighted/item:opacity-100",
        )}
      >
        <PinIcon className={cn("size-3.5", pinned && "fill-current")} />
      </span>
    </MenuItem>
  );
}
