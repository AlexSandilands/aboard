import { BRAND } from "@repo/contracts";
import { MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { useDialogs } from "~/state/ui";

/** Icon control drawn on the banner art, inked to match it (T3's media-control treatment). */
function BackdropIconButton({ label, ...props }: { label: string } & ComponentProps<"button">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[color-mix(in_srgb,var(--stage-ink)_70%,transparent)] outline-none hover:bg-[color-mix(in_srgb,var(--stage-ink)_10%,transparent)] hover:text-[var(--stage-ink)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--stage-ink)] [&_svg]:size-4"
            {...props}
          />
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The 52px titlebar row of the sidebar: stage art, wordmark, settings and theme. */
export function SidebarBrandRow() {
  const { resolvedTheme, setTheme } = useTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <div className="stage-ink relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 ps-4 pe-2">
      <SidebarStageBackdrop />
      <span className="relative z-10 min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-[var(--stage-ink)]">
        {BRAND.name}
      </span>
      <div className="relative z-10 flex items-center">
        <BackdropIconButton label={`Switch to ${nextTheme} theme`} onClick={() => setTheme(nextTheme)}>
          {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
        </BackdropIconButton>
        <BackdropIconButton label="Settings" onClick={() => useDialogs.getState().setAppSettingsOpen(true)}>
          <SettingsIcon />
        </BackdropIconButton>
      </div>
    </div>
  );
}
