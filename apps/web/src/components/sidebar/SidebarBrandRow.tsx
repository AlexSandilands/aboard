import { BRAND } from "@repo/contracts";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";

/** The titlebar row of the sidebar: stage art and wordmark. */
export function SidebarBrandRow() {
  return (
    <div className="drag-region stage-ink relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 ps-4 pe-2">
      <SidebarStageBackdrop />
      <span className="relative z-10 min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-[var(--stage-ink)]">
        {BRAND.name}
      </span>
    </div>
  );
}
