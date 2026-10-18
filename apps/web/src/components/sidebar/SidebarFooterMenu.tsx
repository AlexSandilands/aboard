// Adapted from T3 Code (apps/web/src/components/sidebar/SidebarChrome.tsx), MIT — see NOTICE.
import { ArrowLeftIcon, BarChart3Icon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarFooter, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { useInStats, useLeaveStats, useOpenStats } from "~/components/stats/useOpenStats";

function SidebarUtilityItem({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/** Bottom row of the sidebar: settings, stats and the light/dark theme flip; on the stats page, just Back. */
export function SidebarFooterMenu() {
  const { resolvedTheme, setTheme } = useTheme();
  const openSettings = useOpenSettings();
  const openStats = useOpenStats();
  const leaveStats = useLeaveStats();
  const { isMobile, setOpenMobile } = useSidebar();
  const inStats = useInStats();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  if (inStats)
    return (
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void leaveStats();
              }}
            >
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    );
  return (
    <SidebarFooter>
      <SidebarMenu className="flex-row items-center">
        <SidebarUtilityItem icon={<SettingsIcon />} label="Settings" onClick={() => openSettings("board")} />
        <SidebarUtilityItem icon={<BarChart3Icon />} label="Stats" onClick={() => void openStats()} />
        <SidebarUtilityItem
          icon={resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
          label={`Switch to ${nextTheme} theme`}
          onClick={() => setTheme(nextTheme)}
        />
      </SidebarMenu>
    </SidebarFooter>
  );
}
