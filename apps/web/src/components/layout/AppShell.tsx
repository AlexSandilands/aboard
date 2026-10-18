import { type KeybindingCommand, storageKey } from "@repo/contracts";
import { type ReactNode, useEffect, useEffectEvent } from "react";
import { CommandPalette } from "~/components/command/CommandPalette";
import { useJumpToTask, useSelectedTaskId } from "~/components/board/boardNavigation";
import { useNotificationDelivery } from "~/components/notifications/useNotificationDelivery";
import { AppDialogs } from "~/components/settings/AppDialogs";
import { ThemeEditorHost } from "~/components/settings/ThemeEditorHost";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { useBoardEvents } from "~/state/queries";
import { anyDialogOpen, useDialogs, usePalette } from "~/state/ui";
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
  useGlobalKeybindings(onBack, newTaskProjectId ?? undefined);

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
      <CommandPalette />
      <AppDialogs />
      <ThemeEditorHost />
    </SidebarProvider>
  );
}

/**
 * App-wide shortcuts, from the registry in `packages/contracts/src/keybindings.ts` with the user's overrides applied
 * (Settings → Keybindings). By default Ctrl/Cmd+K opens the palette, Ctrl/Cmd+, opens Settings, N starts a new
 * task (in the scoped project), J jumps to the open task's card on the board, Esc goes back (closes the detail panel,
 * or leaves Settings).
 *
 * It listens in the capture phase because card controls stop their keydowns from bubbling, which
 * would otherwise hide every shortcut while one of them has focus. Ctrl/Cmd+K runs right away.
 * The rest must still yield to anything nearer the focus (inline inputs, plan editors, menus), and
 * those signal that with `preventDefault`, so they wait until the event has finished dispatching
 * and run only if nothing called it. A plain `stopPropagation` doesn't count as a claim.
 * They therefore can't `preventDefault` themselves, which is fine for the default keys: none has a default action
 * outside text fields.
 */
function useGlobalKeybindings(onBack: (() => unknown) | null, newTaskProjectId: string | undefined) {
  const openSettings = useOpenSettings();
  const selectedTaskId = useSelectedTaskId();
  const jumpToTask = useJumpToTask();
  const bindings = useResolvedKeybindings();
  const run = (command: KeybindingCommand) => {
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
        canGoBack: onBack !== null,
      },
      IS_MAC,
      bindings,
    );
    if (command === null) return;
    if (runsImmediately(command, bindings)) {
      event.preventDefault();
      run(command);
      return;
    }
    // A timeout rather than a microtask: microtasks run between listeners, before the bubble phase.
    setTimeout(() => {
      if (event.defaultPrevented) return;
      run(command);
    }, 0);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener, { capture: true });
    return () => window.removeEventListener("keydown", listener, { capture: true });
  }, []);
}
