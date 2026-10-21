import { Outlet, useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useCloseTask, useProjectFilter, useSelectedTaskId } from "~/components/board/boardNavigation";
import { SettingsSidebar, useSettingsBack } from "~/components/settings/SettingsShell";
import { useInStats, useLeaveStats } from "~/components/stats/useOpenStats";
import { useInSocial, useLeaveSocial } from "~/components/social/useSocialNavigation";
import { AppSidebar } from "~/components/sidebar/AppSidebar";
import { useSidebar } from "~/components/ui/sidebar";
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
  const inStats = useInStats();
  const settingsBack = useSettingsBack();
  const leaveStats = useLeaveStats();
  const inSocial = useInSocial();
  const leaveSocial = useLeaveSocial();
  return (
    <AppShell
      sidebar={inSettings ? <SettingsSidebar /> : <AppSidebar />}
      sidebarLabel={inSettings ? "Settings" : "Projects"}
      onBack={inSettings ? settingsBack : inStats ? leaveStats : inSocial ? leaveSocial : taskId ? closeTask : null}
      // On the project settings page `?project=` is the project being configured, not the board's scope.
      newTaskProjectId={inSettings || projectFilter.length !== 1 ? null : projectFilter[0]}
    >
      <CloseSheetOnSwitch inSettings={inSettings} />
      <Outlet />
    </AppShell>
  );
}

/**
 * On a narrow window the sidebar is a sheet. A pick in it that switches between the board and Settings (a project's
 * gear, Back) would otherwise leave it open over the new page, since the shell outlives the switch. Only the switch
 * closes it: the sheet mounts its contents on opening, so closing on mount would shut it straight away.
 */
function CloseSheetOnSwitch({ inSettings }: { inSettings: boolean }) {
  const { setOpenMobile } = useSidebar();
  const previous = useRef(inSettings);
  useEffect(() => {
    if (previous.current === inSettings) return;
    previous.current = inSettings;
    setOpenMobile(false);
  }, [inSettings, setOpenMobile]);
  return null;
}
