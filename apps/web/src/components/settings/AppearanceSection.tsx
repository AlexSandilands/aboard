import { MonitorIcon, MoonIcon, RefreshCwIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";
import {
  STAGE_BANNERS,
  type StageBannerChoice,
  type StageBannerId,
  resolveStageBanner,
} from "~/components/stage/stageBanner.logic";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { type Theme, useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useAppearance, useBoardView } from "~/state/ui";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Theme and the sidebar banner, both kept in this browser. */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsSection id="board.appearance.settings" title="Appearance">
      <SettingsRow
        id="board.appearance.theme"
        title="Theme"
        control={
          <ToggleGroup
            aria-label="Theme"
            value={[theme]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "light" || value === "dark" || value === "system") setTheme(value satisfies Theme);
            }}
          >
            <Toggle value="light">
              <SunIcon />
              Light
            </Toggle>
            <Toggle value="dark">
              <MoonIcon />
              Dark
            </Toggle>
            <Toggle value="system">
              <MonitorIcon />
              System
            </Toggle>
          </ToggleGroup>
        }
      />
      <BannerRow />
      <PriorityLaneRow />
      <ScrollToTaskRow />
    </SettingsSection>
  );
}

function ScrollToTaskRow() {
  const scroll = useAppearance((s) => s.scrollToTask);
  const setScroll = useAppearance((s) => s.setScrollToTask);
  return (
    <SettingsRow
      id="board.appearance.scroll-to-task"
      title="Scroll to a task when opening it"
      description="Slide the board to the card. Off, only the panel opens."
      control={<Switch checked={scroll} onCheckedChange={setScroll} aria-label="Scroll to a task when opening it" />}
    />
  );
}

function PriorityLaneRow() {
  const show = useBoardView((s) => s.showPriorityLane);
  const setShow = useBoardView((s) => s.setShowPriorityLane);
  return (
    <SettingsRow
      id="board.appearance.priority-lane"
      title="Priority lane"
      description="Priority tasks from every project, in a lane above the projects."
      control={<Switch checked={show} onCheckedChange={setShow} aria-label="Priority lane" />}
    />
  );
}

function BannerRow() {
  const banner = useAppearance((s) => s.banner);
  const setBanner = useAppearance((s) => s.setBanner);
  return (
    <SettingsRow
      id="board.appearance.banner"
      title="Sidebar banner"
      description="The art behind the name in the sidebar."
    >
      <div role="radiogroup" aria-label="Sidebar banner" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STAGE_BANNERS.map((option) => (
          <BannerOption
            key={option.id}
            choice={option.id}
            preview={option.id}
            label={option.label}
            selected={banner === option.id}
            onSelect={setBanner}
          />
        ))}
        <BannerOption
          choice="rotate"
          preview={resolveStageBanner("rotate")}
          label={
            <>
              <RefreshCwIcon className="size-3" />
              Rotate daily
            </>
          }
          selected={banner === "rotate"}
          onSelect={setBanner}
        />
      </div>
    </SettingsRow>
  );
}

function BannerOption({
  choice,
  preview,
  label,
  selected,
  onSelect,
}: {
  choice: StageBannerChoice;
  preview: StageBannerId;
  label: ReactNode;
  selected: boolean;
  onSelect: (choice: StageBannerChoice) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(choice)}
      className={cn(
        "stage-ink relative flex h-12 cursor-pointer items-center overflow-hidden rounded-lg border bg-sidebar px-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary ring-1 ring-primary" : "border-border/60 hover:border-border",
      )}
    >
      <SidebarStageBackdrop banner={preview} />
      <span className="relative z-10 flex items-center gap-1.5 text-xs font-medium text-[var(--stage-ink)]">
        {label}
      </span>
    </button>
  );
}
