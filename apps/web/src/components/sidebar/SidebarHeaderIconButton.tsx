// Adapted from T3 Code (apps/web/src/components/sidebar/SidebarThreadHeader.tsx), MIT — see NOTICE.
import type { ComponentProps, ReactNode } from "react";
import { SidebarMenuButton } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Icon button with a tooltip, sized for the header's segmented group. Spreads unknown props
 * through so it can serve as a popup trigger's render target.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<ComponentProps<typeof SidebarMenuButton>, "children" | "className" | "tooltip" | "isActive" | "aria-label">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton size="icon" type="button" aria-label={label} {...rest} className={cn("relative size-7 shrink-0", className)} />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
