import { Outlet, useLocation } from "@tanstack/react-router";
import { useCloseTask, useProjectFilter, useSelectedTaskId } from "~/components/board/boardNavigation";
import { SettingsSidebar, useSettingsBack } from "~/components/settings/SettingsShell";
import { AppSidebar } from "~/components/sidebar/AppSidebar";
import { AppShell } from "./AppShell";

/**
 * The layout route around the board and Settings. One `AppShell` stays mounted across both, so moving between them
 * keeps the live-update stream, the notification delivery and the sidebar's state; only the sidebar's contents and
 * what Esc does change.
 */
export function AppFrame() {
  const inSettings = useLocation({ select: (location) => location.pathname.startsWith("/settings") });
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  const projectFilter = useProjectFilter();
  const settingsBack = useSettingsBack();
  return (
    <AppShell
      sidebar={inSettings ? <SettingsSidebar /> : <AppSidebar />}
      sidebarLabel={inSettings ? "Settings" : "Projects"}
      onBack={inSettings ? settingsBack : taskId ? closeTask : null}
      // On the project settings page `?project=` is the project being configured, not the board's scope.
      newTaskProjectId={inSettings ? null : projectFilter}
    >
      <Outlet />
    </AppShell>
  );
}
