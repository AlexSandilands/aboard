import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SidebarStageBackdrop } from "~/components/SidebarStageBackdrop";
import {
  STAGE_BANNERS,
  type StageBannerChoice,
  type StageBannerId,
  resolveStageBanner,
} from "~/components/stage/stageBanner.logic";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { DEFAULT_PINNED_LANE_HEIGHT, PINNED_LANE_HEIGHTS, type PinnedLaneHeight } from "~/state/boardView.logic";
import { useAppearance, useBoardView } from "~/state/ui";
import {
  CONTRAST,
  DEFAULT_APPEARANCE_PREFS,
  GLASS_OPACITY,
  INTERFACE_FONT_SIZE,
  PANEL_ANIMATION_MS,
} from "~/theme/appearance.logic";
import { isFontFamilyAvailable, isMonospaceFamily } from "~/theme/fonts";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { ThemeLibrary } from "./ThemeLibrary";

/** Theme, look and type, all kept in this browser. Laid out like T3 Code's Appearance page. */
export function AppearanceSection() {
  return (
    <>
      <section id="board.appearance.theme" className="scroll-mt-4 space-y-2.5">
        <h2 className="flex min-h-7 items-center px-3 text-sm font-normal text-foreground/70 sm:px-4">
          Colors & themes
        </h2>
        <ThemeLibrary />
      </section>
      <SettingsSection id="board.appearance.settings" title="Interface">
        <ContrastRow />
        <GlassOpacityRow />
        <BannerRow />
        <PriorityLaneRow />
        <PinnedLaneHeightRow />
        <ScrollToTaskRow />
        <AutopilotCountdownRow />
      </SettingsSection>
      <SettingsSection title="Motion">
        <PanelAnimationsRow />
        <SnapshotMotionRow />
        <WindowZoomRow />
      </SettingsSection>
      <SettingsSection title="Typography">
        <FontRow
          id="board.appearance.interface-font"
          title="Interface font"
          description="Everything outside code."
          field="fontSans"
          placeholder="System default"
          withSize
        />
        <FontRow
          id="board.appearance.mono-font"
          title="Monospace font"
          description="Code, ids and keyboard shortcuts."
          field="fontMono"
          placeholder="System monospace"
          requireMonospace
        />
      </SettingsSection>
    </>
  );
}

function ContrastRow() {
  const contrast = useAppearance((s) => s.contrast);
  const setPrefs = useAppearance((s) => s.setPrefs);
  return (
    <SettingsRow
      id="board.appearance.contrast"
      title="Contrast"
      description="Adjust the contrast of text and borders across the board."
      resetAction={
        contrast !== CONTRAST.default ? (
          <SettingResetButton label="contrast" onClick={() => setPrefs({ contrast: CONTRAST.default })} />
        ) : null
      }
      control={
        <Slider
          id="appearance-contrast"
          label="Contrast"
          value={contrast}
          {...CONTRAST}
          format={(v) => `${v}%`}
          onValueChange={(v) => setPrefs({ contrast: v })}
        />
      }
    />
  );
}

function GlassOpacityRow() {
  const glassOpacity = useAppearance((s) => s.glassOpacity);
  const setPrefs = useAppearance((s) => s.setPrefs);
  return (
    <SettingsRow
      id="board.appearance.glass-opacity"
      title="Glass opacity"
      description="Higher values make menus, dialogs and popovers more solid."
      resetAction={
        glassOpacity !== GLASS_OPACITY.default ? (
          <SettingResetButton label="glass opacity" onClick={() => setPrefs({ glassOpacity: GLASS_OPACITY.default })} />
        ) : null
      }
      control={
        <Slider
          id="appearance-glass-opacity"
          label="Glass opacity"
          value={glassOpacity}
          {...GLASS_OPACITY}
          format={(v) => `${v}%`}
          onValueChange={(v) => setPrefs({ glassOpacity: v })}
        />
      }
    />
  );
}

function PanelAnimationsRow() {
  const durationMs = useAppearance((s) => s.panelAnimationMs);
  const setPrefs = useAppearance((s) => s.setPrefs);
  return (
    <SettingsRow
      id="board.appearance.panel-animations"
      title="Panel animations"
      description="Set how fast the sidebar and the task panel slide in and out; the slide takes three times this. 0 ms turns it off."
      resetAction={
        durationMs !== PANEL_ANIMATION_MS.default ? (
          <SettingResetButton
            label="panel animations"
            onClick={() => setPrefs({ panelAnimationMs: PANEL_ANIMATION_MS.default })}
          />
        ) : null
      }
      control={
        <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
          <PanelAnimationsPreview durationMs={durationMs} />
          <Slider
            id="appearance-panel-animation-duration"
            label="Panel animation duration"
            value={durationMs}
            {...PANEL_ANIMATION_MS}
            format={(v) => `${v} ms`}
            onValueChange={(v) => setPrefs({ panelAnimationMs: v })}
            className="sm:w-full"
          />
        </div>
      }
    />
  );
}

/**
 * A font family typed by name, committed on Enter or when the field loses focus. A name the browser can't draw (or,
 * for the monospace font, one that isn't monospaced) is kept in the field, marked invalid, and not applied.
 */
function FontRow({
  id,
  title,
  description,
  field,
  placeholder,
  withSize = false,
  requireMonospace = false,
}: {
  id: string;
  title: string;
  description: string;
  field: "fontSans" | "fontMono";
  placeholder: string;
  withSize?: boolean;
  requireMonospace?: boolean;
}) {
  const value = useAppearance((s) => s[field]);
  const fontSize = useAppearance((s) => s.fontSize);
  const setPrefs = useAppearance((s) => s.setPrefs);
  const [draft, setDraft] = useState(value);
  const [adopted, setAdopted] = useState(value);
  // A reset or another tab changed the saved value: show it.
  if (adopted !== value) {
    setAdopted(value);
    setDraft(value);
  }
  const accepts = (candidate: string) =>
    candidate.trim().length === 0 ||
    (isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate)));
  const invalid = draft.trim() !== value.trim() && !accepts(draft);
  const commit = () => {
    if (draft.trim() !== value.trim() && accepts(draft)) setPrefs({ [field]: draft.trim() });
  };
  const changed = value !== DEFAULT_APPEARANCE_PREFS[field] || (withSize && fontSize !== INTERFACE_FONT_SIZE.default);
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={
        changed ? (
          <SettingResetButton
            label={title.toLowerCase()}
            onClick={() =>
              setPrefs(withSize ? { [field]: "", fontSize: INTERFACE_FONT_SIZE.default } : { [field]: "" })
            }
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            size="sm"
            aria-label={`${title} family`}
            aria-invalid={invalid || undefined}
            autoCapitalize="off"
            autoComplete="off"
            className="min-w-0 flex-1 sm:w-44 sm:flex-none"
            maxLength={200}
            placeholder={placeholder}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                // Drop the typing without closing the settings page, which an unhandled Escape does.
                event.preventDefault();
                event.stopPropagation();
                setDraft(value);
              }
            }}
          />
          {withSize ? (
            <Select
              value={String(fontSize)}
              onValueChange={(next) => {
                if (typeof next === "string") setPrefs({ fontSize: Number(next) });
              }}
            >
              <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={`${title} size`}>
                <SelectValue>{fontSize} px</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Array.from(
                  { length: INTERFACE_FONT_SIZE.max - INTERFACE_FONT_SIZE.min + 1 },
                  (_, index) => INTERFACE_FONT_SIZE.min + index,
                ).map((px) => (
                  <SelectItem hideIndicator key={px} value={String(px)}>
                    {px} px
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      }
    />
  );
}

function SnapshotMotionRow() {
  const snapshot = useAppearance((s) => s.boardMotion === "snapshot");
  const setPrefs = useAppearance((s) => s.setPrefs);
  return (
    <SettingsRow
      id="board.appearance.snapshot-motion"
      title="Smooth board motion"
      description="Move the board's cards as snapshots while the sidebar or the task panel slides, laying the board out once instead of every frame, so it keeps up with high refresh rate screens. Off, the board is laid out again every frame as it makes room."
      control={
        <Switch
          checked={snapshot}
          onCheckedChange={(on) => setPrefs({ boardMotion: on ? "snapshot" : "reflow" })}
          aria-label="Smooth board motion"
        />
      }
    />
  );
}

function WindowZoomRow() {
  const zoom = useAppearance((s) => s.windowZoom);
  const animationsOff = useAppearance((s) => s.panelAnimationMs === 0);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const setPrefs = useAppearance((s) => s.setPrefs);
  // The zoom follows Panel animations: with those off there is nothing for the switch to turn on.
  const off = reducedMotion
    ? "Off while your system asks for reduced motion."
    : animationsOff
      ? "Off while Panel animations is at 0 ms."
      : null;
  return (
    <SettingsRow
      id="board.appearance.window-zoom"
      title="Zoom windows from their source"
      description="Grow the task window out of the task's card, or out of the side panel when that is open, and shrink it back when it docks or closes. It takes twice the Panel animations time. Off, the window fades in place."
      status={off}
      control={
        <Switch
          checked={zoom && off === null}
          disabled={off !== null}
          onCheckedChange={(on) => setPrefs({ windowZoom: on })}
          aria-label="Zoom windows from their source"
        />
      }
    />
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

function AutopilotCountdownRow() {
  const show = useBoardView((s) => s.showAutopilotTimer);
  const setShow = useBoardView((s) => s.setShowAutopilotTimer);
  return (
    <SettingsRow
      id="board.appearance.autopilot-countdown"
      title="Autopilot countdown on lanes"
      description="The lane's Autopilot pill counts down to Orchestrate's next check (Autopilot · 12m) while it is on in the project."
      control={<Switch checked={show} onCheckedChange={setShow} aria-label="Autopilot countdown on lanes" />}
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

function PinnedLaneHeightRow() {
  const show = useBoardView((s) => s.showPriorityLane);
  const height = useBoardView((s) => s.pinnedLaneHeight);
  const setHeight = useBoardView((s) => s.setPinnedLaneHeight);
  // A stored value that isn't a size reads as the default, as the lane itself does.
  const shown = Object.hasOwn(PINNED_LANE_HEIGHTS, height) ? height : DEFAULT_PINNED_LANE_HEIGHT;
  return (
    <SettingsRow
      id="board.appearance.pinned-lane-height"
      title="Pinned lane height"
      description="The most of the window the priority lane takes while pinned and scrolled."
      control={
        <Select
          value={shown}
          disabled={!show}
          onValueChange={(next) => {
            if (next) setHeight(next);
          }}
        >
          <SelectTrigger size="sm" className="w-36 shrink-0" aria-label="Pinned lane height">
            <SelectValue>{PINNED_LANE_HEIGHTS[shown].label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(PINNED_LANE_HEIGHTS) as PinnedLaneHeight[]).map((key) => (
              <SelectItem hideIndicator key={key} value={key}>
                {PINNED_LANE_HEIGHTS[key].label} ({PINNED_LANE_HEIGHTS[key].vh}% of the window)
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
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
