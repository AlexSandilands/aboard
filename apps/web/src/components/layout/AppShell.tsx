import { type BoardSnapshot, type KeybindingCommand, storageKey, type TaskDetail } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";
import { CommandPalette } from "~/components/command/CommandPalette";
import { useCloseTask, useJumpToTask, useOpenTask, useSelectedTaskId } from "~/components/board/boardNavigation";
import { UpdatePill } from "~/components/desktop/UpdatePill";
import { useNotificationDelivery } from "~/components/notifications/useNotificationDelivery";
import { AppDialogs } from "~/components/settings/AppDialogs";
import { ThemeEditorHost } from "~/components/settings/ThemeEditorHost";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail, useSidebar } from "~/components/ui/sidebar";
import { queryKeys, useBoardEvents } from "~/state/queries";
import { anyDialogOpen, type DeletableTask, useDialogs, usePalette } from "~/state/ui";
import { IS_MAC, isEditableTarget, isInsidePopup, isRecordingShortcut } from "./keyboard";
import { resolveCommand, runsImmediately } from "./keyboard.logic";
import { useResolvedKeybindings } from "./useKeybindings";

const SIDEBAR_WIDTH_STORAGE_KEY = storageKey("sidebar-width");
/** The main area keeps at least this much room when the sidebar is dragged wider. */
const MAIN_CONTENT_MIN_WIDTH = 480;

/**
 * The frame every page shares: the resizable sidebar (off-canvas on narrow windows), the main area, the palette,
 * the app dialogs, live sync and the app-wide shortcuts. The board and Settings each bring their own sidebar
 * contents. `onBack` is what Escape does when nothing nearer the focus wants it; null when it does nothing.
 * `newTaskProjectId` is where N puts a new task.
 */
export function AppShell({
  sidebar,
  sidebarLabel,
  onBack,
  newTaskProjectId,
  children,
}: {
  sidebar: ReactNode;
  sidebarLabel: string;
  onBack: (() => unknown) | null;
  newTaskProjectId?: string | null;
  children: ReactNode;
}) {
  useBoardEvents();
  useNotificationDelivery();

  return (
    <SidebarProvider className="h-dvh! min-h-0!">
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        role="navigation"
        aria-label={sidebarLabel}
        resizable={{
          minWidth: 208,
          maxWidth: 480,
          storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth || wrapper.clientWidth - nextWidth >= MAIN_CONTENT_MIN_WIDTH,
        }}
      >
        {sidebar}
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 flex-row overflow-hidden">{children}</SidebarInset>
      <GlobalKeybindings onBack={onBack} newTaskProjectId={newTaskProjectId ?? undefined} />
      <CommandPalette />
      <AppDialogs />
      <ThemeEditorHost />
      <UpdatePill />
    </SidebarProvider>
  );
}

/** The card a key event came from: a board card with focus, not a control inside one. */
function focusedCardId(target: EventTarget | null): string | null {
  return target instanceof HTMLElement ? (target.dataset.taskCard ?? null) : null;
}

const pickDeletable = ({ id, number, title, kind }: DeletableTask): DeletableTask => ({ id, number, title, kind });

/**
 * App-wide shortcuts, from the registry in `packages/contracts/src/keybindings.ts` with the user's overrides applied
 * (Settings → Keybindings). By default Ctrl/Cmd+K opens the palette, Ctrl/Cmd+, opens Settings, N starts a new
 * task (in the scoped project), J jumps to the open task's card on the board, Esc goes back (closes the detail panel,
 * or leaves Settings), Ctrl/Cmd+B shows or hides the sidebar and Ctrl/Cmd+Alt+B closes the task panel or reopens the last task.
 * A component, not a hook, so it sits inside the SidebarProvider.
 *
 * It listens in the capture phase because card controls stop their keydowns from bubbling, which
 * would otherwise hide every shortcut while one of them has focus. Ctrl/Cmd+K runs right away.
 * The rest must still yield to anything nearer the focus (inline inputs, plan editors, menus), and
 * those signal that with `preventDefault`, so they wait until the event has finished dispatching
 * and run only if nothing called it. A plain `stopPropagation` doesn't count as a claim.
 * They therefore can't `preventDefault` themselves, which is fine for the default keys: none has a default action
 * outside text fields.
 */
function GlobalKeybindings({
  onBack,
  newTaskProjectId,
}: {
  onBack: (() => unknown) | null;
  newTaskProjectId: string | undefined;
}) {
  const openSettings = useOpenSettings();
  const selectedTaskId = useSelectedTaskId();
  const jumpToTask = useJumpToTask();
  const openTask = useOpenTask();
  const closeTask = useCloseTask();
  const { toggleSidebar } = useSidebar();
  // The task the panel last showed, which panel.toggle reopens.
  const lastTaskId = useRef(selectedTaskId);
  useEffect(() => {
    if (selectedTaskId) lastTaskId.current = selectedTaskId;
  }, [selectedTaskId]);
  const bindings = useResolvedKeybindings();
  const queryClient = useQueryClient();
  /** What the confirmation needs of a task: from the board, or the panel's detail for an archived one. */
  const deletable = (id: string): DeletableTask | undefined =>
    queryClient.getQueryData<BoardSnapshot>(queryKeys.board)?.tasks.find((t) => t.id === id) ??
    queryClient.getQueryData<TaskDetail>(queryKeys.task(id));
  const run = (command: KeybindingCommand, target: EventTarget | null) => {
    const palette = usePalette.getState();
    switch (command) {
      case "palette.open":
        if (!palette.open) palette.openPalette();
        return;
      case "idea.new":
        palette.openPalette({ kind: "new-task", projectId: newTaskProjectId });
        return;
      case "settings.open":
        if (!location.pathname.startsWith("/settings")) openSettings();
        return;
      case "back":
        onBack?.();
        return;
      case "task.reveal":
        if (selectedTaskId) jumpToTask(selectedTaskId);
        return;
      case "sidebar.toggle":
        toggleSidebar();
        return;
      case "panel.toggle":
        if (selectedTaskId) void closeTask();
        else if (lastTaskId.current) void openTask(lastTaskId.current, { reveal: false });
        return;
      case "task.delete": {
        const cardId = focusedCardId(target);
        const task = deletable(cardId ?? selectedTaskId ?? "");
        if (!task) return;
        // The panel closes once it is confirmed, as the menu's Delete… does; a card's panel stays put.
        const onDeleted = task.id === selectedTaskId ? () => void closeTask() : undefined;
        useDialogs.getState().openDeleteTask([pickDeletable(task)], onDeleted);
        return;
      }
      default:
        command satisfies never;
    }
  };
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || isRecordingShortcut(event.target)) return;
    const palette = usePalette.getState();
    const dialogs = useDialogs.getState();
    const settingsOpen = location.pathname.startsWith("/settings");
    const command = resolveCommand(
      event,
      {
        editableFocus: isEditableTarget(event.target),
        popupFocus: isInsidePopup(event.target),
        overlayOpen: palette.open || dialogs.digestOpen,
        paletteOpen: palette.open,
        dialogOpen: anyDialogOpen(dialogs),
        settingsOpen,
        // The task panel, not the stats page, which also has an `onBack`.
        panelOpen: selectedTaskId !== null && !settingsOpen,
        cardFocus: focusedCardId(event.target) !== null,
        canGoBack: onBack !== null,
      },
      IS_MAC,
      bindings,
    );
    if (command === null) return;
    if (runsImmediately(command, bindings)) {
      event.preventDefault();
      run(command, event.target);
      return;
    }
    // A timeout rather than a microtask: microtasks run between listeners, before the bubble phase.
    setTimeout(() => {
      if (event.defaultPrevented) return;
      run(command, event.target);
    }, 0);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener, { capture: true });
    return () => window.removeEventListener("keydown", listener, { capture: true });
  }, []);
  return null;
}
