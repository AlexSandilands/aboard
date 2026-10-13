import { storageKey } from "@repo/contracts";
import { useEffect, useRef } from "react";
import { Board } from "~/components/board/Board";
import { useCloseTask, useProjectFilter, useSelectedTaskId } from "~/components/board/boardNavigation";
import { CommandPalette } from "~/components/command/CommandPalette";
import { AppDialogs } from "~/components/settings/AppDialogs";
import { AppSidebar } from "~/components/sidebar/AppSidebar";
import { TaskPanel } from "~/components/task/TaskPanel";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { useBoardEvents } from "~/state/queries";
import { useDialogs, usePalette } from "~/state/ui";
import { isEditableTarget, isInsidePopup } from "./keyboard";

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

/**
 * App-wide shortcuts: Ctrl/Cmd+K opens the palette, N starts a new idea (in the scoped project),
 * Esc closes the detail panel when nothing nearer to the focus claims it.
 */
function useGlobalKeybindings(panelOpen: boolean, closePanel: () => unknown) {
  const projectFilter = useProjectFilter();
  const latest = useRef({ panelOpen, closePanel, projectFilter });
  latest.current = { panelOpen, closePanel, projectFilter };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const palette = usePalette.getState();
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!palette.open) palette.openPalette();
        return;
      }
      const dialogs = useDialogs.getState();
      const overlayOpen = palette.open || dialogs.appSettingsOpen || dialogs.projectSettingsId !== null;
      if (overlayOpen || isEditableTarget(event.target) || isInsidePopup(event.target)) return;
      if (event.key === "Escape" && latest.current.panelOpen) {
        event.preventDefault();
        latest.current.closePanel();
        return;
      }
      if (!modifier && !event.altKey && (event.key === "n" || event.key === "N") && !event.shiftKey) {
        event.preventDefault();
        palette.openPalette({ kind: "new-idea", projectId: latest.current.projectFilter ?? undefined });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
