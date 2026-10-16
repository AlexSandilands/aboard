import { storageKey } from "@repo/contracts";
import { useEffect, useEffectEvent } from "react";
import { Board } from "~/components/board/Board";
import { useCloseTask, useProjectFilter, useSelectedTaskId } from "~/components/board/boardNavigation";
import { CommandPalette } from "~/components/command/CommandPalette";
import { AppDialogs } from "~/components/settings/AppDialogs";
import { AppSidebar } from "~/components/sidebar/AppSidebar";
import { TaskPanel } from "~/components/task/TaskPanel";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { useBoardEvents } from "~/state/queries";
import { useDialogs, usePalette } from "~/state/ui";
import { isEditableTarget, isInsidePopup, resolveCommand, runsImmediately, type KeybindingCommand } from "./keyboard";

const SIDEBAR_WIDTH_STORAGE_KEY = storageKey("sidebar-width");
/** The board keeps at least this much room when the sidebar is dragged wider. */
const MAIN_CONTENT_MIN_WIDTH = 480;

/** Route component for "/": sidebar, board, and the `?task=` detail panel docked right. */
export function AppLayout() {
  useBoardEvents();
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  useGlobalKeybindings(taskId !== null, closeTask);

  return (
    <SidebarProvider className="h-dvh! min-h-0!">
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        role="navigation"
        aria-label="Projects"
        resizable={{
          minWidth: 208,
          maxWidth: 480,
          storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth || wrapper.clientWidth - nextWidth >= MAIN_CONTENT_MIN_WIDTH,
        }}
      >
        <AppSidebar />
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 flex-row overflow-hidden">
        <Board />
        {taskId ? <TaskPanel taskId={taskId} onClose={() => void closeTask()} /> : null}
      </SidebarInset>
      <CommandPalette />
      <AppDialogs />
    </SidebarProvider>
  );
}

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);

/**
 * App-wide shortcuts from the table in `keyboard.ts`: Ctrl/Cmd+K opens the palette, N starts a new
 * task (in the scoped project), Esc closes the detail panel.
 *
 * It listens in the capture phase because card controls stop their keydowns from bubbling, which
 * would otherwise hide every shortcut while one of them has focus. Ctrl/Cmd+K runs right away.
 * N and Esc must still yield to anything nearer the focus (inline inputs, plan editors, menus), and
 * those signal that with `preventDefault`, so they wait until the event has finished dispatching
 * and run only if nothing called it. A plain `stopPropagation` doesn't count as a claim.
 */
function useGlobalKeybindings(panelOpen: boolean, closePanel: () => unknown) {
  const projectFilter = useProjectFilter();
  const run = (command: KeybindingCommand) => {
    const palette = usePalette.getState();
    if (command === "palette.open") {
      if (!palette.open) palette.openPalette();
    } else if (command === "idea.new") {
      palette.openPalette({ kind: "new-task", projectId: projectFilter ?? undefined });
    } else {
      closePanel();
    }
  };
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing) return;
    const palette = usePalette.getState();
    const dialogs = useDialogs.getState();
    const command = resolveCommand(
      event,
      {
        editableFocus: isEditableTarget(event.target),
        popupFocus: isInsidePopup(event.target),
        overlayOpen: palette.open || dialogs.appSettingsOpen || dialogs.projectSettingsId !== null,
        panelOpen,
        paletteOpen: palette.open,
      },
      IS_MAC,
    );
    if (command === null) return;
    if (runsImmediately(command)) {
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
