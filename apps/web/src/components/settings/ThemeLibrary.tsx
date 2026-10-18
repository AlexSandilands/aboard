// Adapted from T3 Code (apps/web/src/components/settings/ThemeSettings.tsx ThemeLibrary), MIT — see NOTICE.
// The appearance tiles and the theme cards. Creating, importing and removing themes come with custom themes.
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { BUILT_IN_THEMES, type ThemeAppearance } from "~/theme/palettes";
import { findTheme, themeOwners, type ThemeMode } from "~/theme/themeState.logic";
import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
  type ThemeCardDefinition,
  ThemePreviewCircles,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const MODE_LABELS: Record<ThemeMode, string> = { system: "System", light: "Light", dark: "Dark" };

export function ThemeLibrary() {
  const { theme: mode, themeId, themeHalves, customThemes, setTheme, setThemeId, setThemeHalf } = useTheme();
  const owners = themeOwners({ mode, themeId, halves: themeHalves }, customThemes);

  const cardFor = (id: string | null): ThemeCardDefinition => {
    const definition = findTheme(id, customThemes);
    return definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0]!;
  };
  const wireframeColors = (appearance: ThemeAppearance) => {
    const card = cardFor(owners[appearance]);
    return previewColorsOf(card, appearance) ?? card.previews[0]!.colors;
  };
  const pickedModesFor = (cardId: string | null): ThemeMode[] => {
    const rings: ThemeMode[] = [];
    if (owners.light === cardId) rings.push("light");
    if (owners.dark === cardId) rings.push("dark");
    return rings;
  };
  const pickHalf = (cardId: string | null) => (picked: ThemeMode) => {
    if (picked !== "system") setThemeHalf(picked, cardId);
  };

  return (
    <div className="space-y-3">
      <div aria-label="Appearance mode" className="grid w-full grid-cols-3 gap-3" role="group">
        {(["system", "light", "dark"] as const).map((tile) => {
          const isActive = mode === tile;
          return (
            <button
              aria-label={tile === "system" ? "Follow the system appearance" : `Use ${tile} mode`}
              aria-pressed={isActive}
              className={cn(
                "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
                isActive ? "border-transparent bg-accent/30" : "border-border/70 bg-card/60 hover:bg-accent/10",
              )}
              key={tile}
              style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
              onClick={() => setTheme(tile)}
              type="button"
            >
              <ThemeWireframe
                className="h-[8.75rem]"
                panes={
                  tile === "system"
                    ? [
                        { clip: "left", colors: wireframeColors("light") },
                        { clip: "right", colors: wireframeColors("dark") },
                      ]
                    : [{ colors: wireframeColors(tile) }]
                }
              />
              <span
                className={cn(
                  "flex items-center justify-center text-xs font-medium",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {MODE_LABELS[tile]}
              </span>
            </button>
          );
        })}
      </div>
      <h3 className="px-3 pt-2 text-sm font-normal text-foreground/70 sm:px-4">Themes</h3>
      <div
        className="grid w-full gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}
      >
        {STANDARD_THEME_CARDS.map((card) => (
          <ThemeCard
            key={card.id}
            theme={card}
            activeModes={pickedModesFor(null)}
            onUse={() => setThemeId(null)}
            onUseMode={pickHalf(null)}
          />
        ))}
        {[...BUILT_IN_THEMES, ...customThemes].map((definition) => (
          <ThemeCard
            key={definition.id}
            theme={getThemeCardDefinition(definition)}
            activeModes={pickedModesFor(definition.id)}
            onUse={() => setThemeId(definition.id)}
            onUseMode={pickHalf(definition.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** A theme's card: clicking it uses the theme for both appearances, clicking one orb only for that one. */
function ThemeCard({
  theme,
  activeModes,
  onUse,
  onUseMode,
}: {
  theme: ThemeCardDefinition;
  activeModes: ReadonlyArray<ThemeMode>;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
}) {
  const cardModes = theme.previews.map((preview) => preview.mode);
  const isActive = activeModes.length === 2;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // The whole card is a mouse target only; the name button and the orbs inside are the keyboard controls.
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- see above
          <div
            className={cn(
              "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
              isActive && "bg-accent/30",
            )}
            onClick={onUse}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
          >
            <ThemePreviewCircles
              label={theme.label}
              activeModes={activeModes}
              onSelectMode={onUseMode}
              previews={theme.previews}
            />
            <div className="flex items-center gap-2 px-3 pt-2 pb-3">
              <button
                aria-label={`Use ${theme.label} theme${isActive ? ", currently active" : ""}`}
                aria-pressed={isActive}
                className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onUse();
                }}
              >
                {theme.label}
              </button>
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {cardModes.length > 1 ? "Use for both light and dark" : `Use for ${cardModes[0]} mode only`}
      </TooltipPopup>
    </Tooltip>
  );
}
