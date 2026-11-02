import { BRAND } from "@repo/contracts";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";
import { useShortcutLabel } from "~/components/layout/useKeybindings";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** The titlebar row of the sidebar: stage art, the button that hides the sidebar (as in T3 Code) and wordmark. */
export function SidebarBrandRow() {
  const shortcut = useShortcutLabel("sidebar.toggle");
  return (
    <div className="drag-region stage-ink relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1.5 ps-2 pe-2">
      <SidebarStageBackdrop />
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Hide sidebar"
              className="relative z-10 text-[var(--stage-ink)]"
            />
          }
        />
        <TooltipPopup side="bottom">{shortcut ? `Hide sidebar (${shortcut})` : "Hide sidebar"}</TooltipPopup>
      </Tooltip>
      <span className="relative z-10 min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-[var(--stage-ink)]">
        {BRAND.name}
      </span>
    </div>
  );
}
