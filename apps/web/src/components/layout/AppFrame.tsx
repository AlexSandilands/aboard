import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { scopeToRemember } from "~/components/board/projectScope.logic";
import { restoreBoardScope } from "~/components/board/projectScopeRestore";
import { useProjectIds } from "~/state/queries";
import { useProjectScope } from "~/state/ui";
import { useCloseTask, useProjectFilter, useSelectedTaskId, useTaskExpanded } from "~/components/board/boardNavigation";
import { useSettingsBack } from "~/components/settings/SettingsShell";
import { useInSocial, useLeaveSocial } from "~/components/social/useSocialNavigation";
import { useSidebar } from "~/components/ui/sidebar";
import { AppLayout } from "./AppLayout";
import { closeAppWindow } from "./AppRouteModal";
import { AppShell } from "./AppShell";
import { isAppModalPath, showsBoard } from "./appModal.logic";

/**
 * The layout route around every page. One `AppShell` stays mounted across them, and so does the board: Settings and
 * Stats render in a floating window over it (`AppRouteModal`, inside their route components), so opening and closing
 * one keeps the board's scroll, its open task panel and the live-update stream. The board behind is inert and reads
 * its search from where it was left (`useBoardSearch`). Only the social feed is a page of its own.
 */
export function AppFrame() {
  useRememberProjectScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const windowOpen = isAppModalPath(pathname);
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  const taskExpanded = useTaskExpanded();
  const projectFilter = useProjectFilter();
  const settingsBack = useSettingsBack();
  const inSocial = useInSocial();
  const leaveSocial = useLeaveSocial();
  return (
    <AppShell
      background={windowOpen}
      onBack={
        pathname.startsWith("/settings")
          ? settingsBack
          : windowOpen
            ? closeAppWindow
            : inSocial
              ? leaveSocial
              : taskId
                ? // The task window docks first; a second Esc closes the task.
                  taskExpanded
                  ? closeAppWindow
                  : closeTask
                : null
      }
      newTaskProjectId={projectFilter.length === 1 ? projectFilter[0] : null}
    >
      <CloseSheetOnWindow windowOpen={windowOpen} />
      {showsBoard(pathname) ? <AppLayout /> : null}
      <Outlet />
    </AppShell>
  );
}

/**
 * On a narrow window the sidebar is a sheet. A pick in it that opens a window (Settings, Stats, a project's gear)
 * would otherwise leave the sheet open over it. Only the change closes it: the sheet mounts its contents on opening,
 * so closing on mount would shut it straight away.
 */
function CloseSheetOnWindow({ windowOpen }: { windowOpen: boolean }) {
  const { setOpenMobile } = useSidebar();
  const previous = useRef(windowOpen);
  useEffect(() => {
    if (previous.current === windowOpen) return;
    previous.current = windowOpen;
    if (windowOpen) setOpenMobile(false);
  }, [windowOpen, setOpenMobile]);
  return null;
}

/**
 * Keeps the project scope the URL shows for the next start (see `restoredProjectScope`, applied in main.tsx). Reading
 * the URL rather than hooking each place that sets the scope covers the project menu, the palette, saved views and
 * Back alike.
 */
function useRememberProjectScope() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const project = useSearch({ strict: false, select: (search) => search.project });
  const inprogress = useSearch({ strict: false, select: (search) => search.inprogress });
  const order = useProjectIds();
  const navigate = useNavigate();
  useEffect(() => {
    // The app started on another page and the board is reached now: it takes the remembered scope instead of
    // overwriting it with the bare URL's (no scope).
    const restored = restoreBoardScope(pathname, { project, inprogress });
    if (restored) {
      void navigate({ to: "/", replace: true, search: (prev) => ({ ...prev, project: restored }) });
      return;
    }
    const ids = scopeToRemember(pathname, { project, inprogress }, order);
    if (!ids) return;
    const { projectIds, setProjectIds } = useProjectScope.getState();
    if (ids.join(",") !== projectIds.join(",")) setProjectIds(ids);
  }, [pathname, project, inprogress, order, navigate]);
}
