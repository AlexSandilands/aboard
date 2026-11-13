import { type Project, type TaskDetail, type TaskSummary } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellOffIcon,
  CheckIcon,
  CircleCheckBigIcon,
  CopyIcon,
  FilePlus2Icon,
  FolderInputIcon,
  GroupIcon,
  LinkIcon,
  ListTodoIcon,
  LocateFixedIcon,
  Maximize2Icon,
  Minimize2Icon,
  PinIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareCheckIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode, SyntheticEvent } from "react";

import { dockTaskWindow } from "./taskWindowExit";
import { useJumpToTask, useOpenTask, useSelectedTaskId, useTaskExpanded } from "~/components/board/boardNavigation";
import { useShortcutLabel } from "~/components/layout/useKeybindings";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { draftFromTask } from "~/components/templates/templates.logic";
import {
  MenuItem,
  MenuItemLabel,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useDismissAttention, useResolveTask, useUpdateTask } from "~/state/mutations";
import { fetchTaskDetail, useBoard } from "~/state/queries";
import { useDialogs, usePalette } from "~/state/ui";
import { epicOptions } from "./epic.logic";
import { copyToClipboard } from "./InlineInput";
import { menuActions, type PinnableAction } from "./taskActions.logic";
import { useSetTaskStatus } from "./useSetTaskStatus";

export interface ActionDef {
  label: string;
  icon: LucideIcon;
  run: () => void;
  /** The key that does the same, shown in the tooltip. */
  shortcut?: string | null;
}

/** The pinnable actions of a task's menu (and so of the buttons pinned beside the panel title). */
export function useTaskMenuActions(task: TaskSummary, onOpenPlanEditor: () => void): Record<PinnableAction, ActionDef> {
  const { mutate: updateTask } = useUpdateTask();
  const setStatus = useSetTaskStatus(task, onOpenPlanEditor);
  const jumpToTask = useJumpToTask();
  const jumpShortcut = useShortcutLabel("task.reveal");
  const hasPlan = task.progress.total > 0;
  const archived = task.archivedAt !== null;
  return {
    jump: { label: "Jump to card", icon: LocateFixedIcon, run: () => jumpToTask(task.id), shortcut: jumpShortcut },
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
  };
}

/** Pin toggles on the menu rows: only the panel's More menu has them. */
export interface MenuPins {
  pinned: ReadonlyArray<PinnableAction>;
  onToggle: (id: PinnableAction) => void;
}

/**
 * The items of a task's menu: the panel's More menu and the card context menu share them. Needs only a summary, since
 * cards have no more; Save as template fetches the rest when picked (the panel passes the detail it has). Render it
 * inside any menu popup. The close-as and delete dialogs are the app's (see TaskMenuDialogs), so they outlive the menu.
 */
export function TaskMenuItems({
  task,
  detail,
  projects,
  onOpenPlanEditor,
  onDeleted,
  pins,
  leading,
  omit,
}: {
  task: TaskSummary;
  detail?: TaskDetail;
  projects: ReadonlyArray<Project>;
  onOpenPlanEditor: () => void;
  /** Runs when deleting is confirmed, e.g. the panel closing itself. */
  onDeleted?: () => void;
  pins?: MenuPins;
  /** Items above the shared ones, e.g. a card's Move to. */
  leading?: ReactNode;
  /** Actions to leave out, e.g. Jump to card on the card itself. */
  omit?: ReadonlyArray<PinnableAction>;
}) {
  const { mutate: updateTask } = useUpdateTask();
  const { mutate: resolveTask } = useResolveTask();
  const { mutate: dismissAttention } = useDismissAttention();
  const queryClient = useQueryClient();
  const actions = useTaskMenuActions(task, onOpenPlanEditor);
  const deleteShortcut = useShortcutLabel("task.delete");
  const board = useBoard().data;
  const epics = epicOptions(board?.tasks ?? [], task);
  const archived = task.archivedAt !== null;
  const isEpic = task.kind === "epic";
  const menu = menuActions(task);
  const item = (id: PinnableAction) =>
    menu.includes(id) && !omit?.includes(id) ? (
      <ActionMenuItem
        action={actions[id]}
        pin={pins ? { pinned: pins.pinned.includes(id), toggle: () => pins.onToggle(id) } : undefined}
      />
    ) : null;

  const saveAsTemplate = async () => {
    try {
      const full = detail ?? (await fetchTaskDetail(queryClient, task.id));
      useDialogs.getState().openTemplateDraft(draftFromTask(full));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't open the template",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <>
      {leading}
      <WindowMenuItem task={task} />
      {item("jump")}
      {item("plan")}
      {/* Only while something is flagged. Each flag comes back if what raised it changes. */}
      {task.attention.length > 0 ? (
        <MenuItem onClick={() => dismissAttention({ taskId: task.id })}>
          <BellOffIcon />
          {task.attention.length === 1 ? "Dismiss warning" : "Dismiss all warnings"}
        </MenuItem>
      ) : null}
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
      {isEpic ? null : (
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
      {isEpic || archived ? null : (
        <MenuItem onClick={() => updateTask({ id: task.id, priority: !task.priority })}>
          <StarIcon className={cn(task.priority && "fill-current")} />
          {task.priority ? "Remove priority" : "Mark as priority"}
        </MenuItem>
      )}
      {item("reopen")}
      {isEpic ? null : (
        <MenuSub>
          <MenuSubTrigger>
            <CircleCheckBigIcon />
            {task.resolution ? "Close differently" : "Close as…"}
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem onClick={() => useDialogs.getState().openCloseTaskAs([task], "completed")}>
              <SquareCheckIcon />
              Done by another task…
            </MenuItem>
            <MenuItem onClick={() => useDialogs.getState().openCloseTaskAs([task], "duplicate")}>
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
      {isEpic ? null : (
        <MenuItem onClick={() => void saveAsTemplate()}>
          <FilePlus2Icon />
          Save as template…
        </MenuItem>
      )}
      {item("archive")}
      <MenuSeparator />
      {item("copy-link")}
      <MenuSeparator />
      {/* Last and set apart, so it never sits next to everyday actions; it confirms, and Undo brings the task back. */}
      <MenuItem variant="destructive" onClick={() => useDialogs.getState().openDeleteTask([task], onDeleted)}>
        <Trash2Icon />
        Delete…
        {deleteShortcut ? <MenuShortcut>{deleteShortcut}</MenuShortcut> : null}
      </MenuItem>
    </>
  );
}

/**
 * Open in window: the task (opened, if it isn't) in the task window. In the window's own menu it docks the task again.
 */
function WindowMenuItem({ task }: { task: TaskSummary }) {
  const openTask = useOpenTask();
  const expanded = useTaskExpanded();
  const selectedTaskId = useSelectedTaskId();
  const inWindow = expanded && selectedTaskId === task.id;
  const shortcut = useShortcutLabel("panel.expand");
  return (
    <MenuItem
      onClick={() => {
        if (inWindow) dockTaskWindow();
        else void openTask(task.id, { expanded: true, reveal: false });
      }}
    >
      {inWindow ? <Minimize2Icon /> : <Maximize2Icon />}
      {inWindow ? "Dock to the side" : "Open in window"}
      {/* The key acts on the open task, so another card's menu doesn't show it. */}
      {shortcut && selectedTaskId === task.id ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
    </MenuItem>
  );
}

/** Keeps a pin toggle from activating (and closing) the menu item around it. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

function ActionMenuItem({ action, pin }: { action: ActionDef; pin?: { pinned: boolean; toggle: () => void } }) {
  const Icon = action.icon;
  if (!pin) {
    return (
      <MenuItem onClick={action.run}>
        <Icon />
        <MenuItemLabel>{action.label}</MenuItemLabel>
        {action.shortcut ? <MenuShortcut>{action.shortcut}</MenuShortcut> : null}
      </MenuItem>
    );
  }
  const { pinned, toggle } = pin;
  return (
    <MenuItem className="group/item" onClick={action.run}>
      <Icon />
      <MenuItemLabel>{action.label}</MenuItemLabel>
      {action.shortcut ? <MenuShortcut>{action.shortcut}</MenuShortcut> : null}
      {/* Pointer-only shortcut: the action itself stays reachable here, so the menu keeps its
          single-stop keyboard model rather than nesting a focusable control in each item. */}
      <span
        aria-hidden
        title={pinned ? "Unpin from the title row" : "Pin to the title row"}
        onClick={(event) => {
          stop(event);
          toggle();
        }}
        onMouseUp={stop}
        className={cn(
          action.shortcut ? "ms-1" : "ms-auto",
          "-me-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-foreground/10 hover:text-foreground",
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
