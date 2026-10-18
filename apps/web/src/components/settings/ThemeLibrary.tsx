// Adapted from T3 Code (apps/web/src/components/settings/ThemeSettings.tsx ThemeLibrary), MIT — see NOTICE.
// The appearance tiles and the theme cards, with creating, importing, editing, exporting and removing custom themes.
import {
  CheckIcon,
  CopyIcon,
  MoonIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { customThemeLibrary, useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { BUILT_IN_THEMES, getThemeModes, type ThemeAppearance, type ThemeDefinition } from "~/theme/palettes";
import { serializeThemeFile } from "~/theme/themeFile";
import { findTheme, themeOwners, type ThemeMode } from "~/theme/themeState.logic";
import { collectionVariantLabels, groupCustomThemes } from "./themeCards.logic";
import { useThemeEditorStore } from "./themeEditorStore";
import { ThemeImportDialog } from "./ThemeImportDialog";
import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
  type ThemeCardDefinition,
  ThemePreviewCircle,
  ThemePreviewCircles,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";

const MODE_LABELS: Record<ThemeMode, string> = { system: "System", light: "Light", dark: "Dark" };

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking right away can abort the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function ThemeLibrary() {
  const {
    theme: mode,
    themeId,
    themeHalves,
    customThemes,
    resolvedTheme,
    setTheme,
    setThemeId,
    setThemeHalf,
  } = useTheme();
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [removal, setRemoval] = useState<{ theme: ThemeDefinition; collection: ReadonlyArray<ThemeDefinition> } | null>(
    null,
  );
  const [idsToRemove, setIdsToRemove] = useState<ReadonlyArray<string>>([]);
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
  const startEditor = (input: { editingThemeId?: string; seedThemeId?: string | null; seedName?: string }) =>
    openThemeEditor({
      editingThemeId: input.editingThemeId ?? null,
      seedThemeId: input.seedThemeId ?? null,
      seedName: input.seedName ?? null,
      initialAppearance: resolvedTheme,
    });
  const duplicate = (seedThemeId: string | null, label: string) =>
    startEditor({ seedThemeId, seedName: `${label} copy` });

  const askToRemove = (theme: ThemeDefinition, collection: ReadonlyArray<ThemeDefinition>) => {
    setRemoval({ theme, collection });
    setIdsToRemove(collection.length > 1 ? [] : [theme.id]);
  };
  const confirmRemoval = () => {
    try {
      customThemeLibrary.remove(idsToRemove);
      setRemoval(null);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn’t remove theme",
        description: cause instanceof Error ? cause.message : "Try again.",
      });
    }
  };
  const removingCollection = (removal?.collection.length ?? 0) > 1;
  const removalLabel = removal?.theme.collection?.label ?? removal?.theme.label;

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
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 pt-2 sm:px-4">
        <h3 className="text-sm font-normal text-foreground/70">Themes</h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* A new theme starts from whatever this appearance shows now. */}
          <Button size="xs" variant="outline" onClick={() => startEditor({ seedThemeId: owners[resolvedTheme] })}>
            <PaintbrushIcon />
            Create theme
          </Button>
          <Button size="xs" variant="outline" onClick={() => setIsImportOpen(true)}>
            <PlusIcon />
            Add theme
          </Button>
        </div>
      </div>
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
            onDuplicate={() => duplicate(null, card.label)}
          />
        ))}
        {BUILT_IN_THEMES.map((definition) => (
          <ThemeCard
            key={definition.id}
            theme={getThemeCardDefinition(definition)}
            activeModes={pickedModesFor(definition.id)}
            onUse={() => setThemeId(definition.id)}
            onUseMode={pickHalf(definition.id)}
            onDuplicate={() => duplicate(definition.id, definition.label)}
          />
        ))}
        {groupCustomThemes(customThemes).map(([key, themes]) => (
          <CustomThemeCollectionCard
            key={key}
            themes={themes}
            activeModesFor={pickedModesFor}
            onUse={(theme) => setThemeId(theme.id)}
            onUseMode={(theme, picked) => pickHalf(theme.id)(picked)}
            onDuplicate={(theme) => duplicate(theme.id, theme.label)}
            onEdit={(theme) => startEditor({ editingThemeId: theme.id })}
            onDownload={(theme) => downloadThemeFile(`${theme.id}.json`, serializeThemeFile(theme))}
            onRemove={(theme) => askToRemove(theme, themes)}
          />
        ))}
      </div>
      <ThemeImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
      <Dialog open={removal !== null} onOpenChange={(open) => !open && setRemoval(null)}>
        <DialogPopup showCloseButton={false} className={removingCollection ? "max-w-lg" : "max-w-sm"}>
          <DialogHeader>
            <DialogTitle>
              {removingCollection ? `Remove themes from “${removalLabel}”?` : `Remove “${removal?.theme.label}”?`}
            </DialogTitle>
            <DialogDescription>
              {removingCollection
                ? "Select the variants you want to remove. You can restore them by adding the extension again."
                : "You can bring it back anytime by importing its JSON file."}
            </DialogDescription>
          </DialogHeader>
          {removingCollection ? (
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto px-6 pb-2 sm:grid-cols-2">
              {removal!.collection.map((theme) => {
                const checkboxId = `remove-theme-${theme.id}`;
                return (
                  <label
                    className="group relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 hover:bg-muted/40 has-checked:border-ring has-checked:bg-accent/20"
                    htmlFor={checkboxId}
                    key={theme.id}
                  >
                    <span className="absolute top-2 right-2 inline-grid size-4 grid-cols-1">
                      <input
                        checked={idsToRemove.includes(theme.id)}
                        className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring forced-colors:appearance-auto"
                        id={checkboxId}
                        name="themes-to-remove"
                        type="checkbox"
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setIdsToRemove((current) =>
                            checked ? [...current, theme.id] : current.filter((id) => id !== theme.id),
                          );
                        }}
                      />
                      <CheckIcon className="pointer-events-none col-start-1 row-start-1 size-3 self-center justify-self-center stroke-primary-foreground opacity-0 group-has-checked:opacity-100" />
                    </span>
                    <span className="flex min-h-12 items-center justify-center gap-1">
                      {getThemeCardDefinition(theme).previews.map((preview) => (
                        <span className="flex size-11 shrink-0 items-center justify-center" key={preview.mode}>
                          <span className="flex scale-75">
                            <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />
                          </span>
                        </span>
                      ))}
                    </span>
                    <p className="max-w-full truncate text-center text-sm font-medium text-foreground">{theme.label}</p>
                  </label>
                );
              })}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button disabled={idsToRemove.length === 0} variant="destructive" onClick={confirmRemoval}>
              {removingCollection
                ? `Remove selected${idsToRemove.length > 0 ? ` (${idsToRemove.length})` : ""}`
                : "Remove theme"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function CardAction({
  label,
  tooltip,
  destructive = false,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  destructive?: boolean;
  onClick: () => void;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            variant={destructive ? "ghost-destructive" : "ghost"}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

type VariantOption = {
  themeIndex: number;
  label: string;
  activeModes: ReadonlyArray<ThemeMode>;
  preview: ThemeCardDefinition["previews"][number];
};

type VariantNavigation = {
  collectionLabel: string;
  options: ReadonlyArray<VariantOption>;
  onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void;
};

/**
 * A theme's card: clicking it uses the theme for both appearances, clicking one orb only for that one. A collection's
 * card shows one orb per appearance that fans out into its variants on hover.
 */
function ThemeCard({
  theme,
  activeModes,
  onUse,
  onUseMode,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
  variantNavigation,
}: {
  theme: ThemeCardDefinition;
  activeModes: ReadonlyArray<ThemeMode>;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  onDuplicate?: () => void;
  onEdit?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
  variantNavigation?: VariantNavigation;
}) {
  const cardModes = theme.previews.map((preview) => preview.mode);
  const isActive = !variantNavigation && activeModes.length === 2;
  const name = variantNavigation?.collectionLabel ?? theme.label;
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
            data-theme-library-card={theme.id}
            onClick={onUse}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
          >
            {variantNavigation ? (
              <VariantOrbs navigation={variantNavigation} />
            ) : (
              <ThemePreviewCircles
                label={theme.label}
                activeModes={activeModes}
                onSelectMode={onUseMode}
                previews={theme.previews}
              />
            )}
            <div className="flex items-center gap-2 px-3 pt-2 pb-3">
              <button
                aria-label={`Use ${variantNavigation ? `${name}, ${theme.label} variant` : `${theme.label} theme`}${isActive ? ", currently active" : ""}`}
                aria-pressed={isActive}
                className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card focus-visible:ring-inset"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onUse();
                }}
              >
                {name}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {onDuplicate ? (
                  <CardAction label={`Duplicate ${theme.label}`} tooltip="Duplicate theme" onClick={onDuplicate}>
                    <CopyIcon />
                  </CardAction>
                ) : null}
                {onEdit ? (
                  <CardAction label={`Edit ${theme.label}`} tooltip="Edit theme" onClick={onEdit}>
                    <PenLineIcon />
                  </CardAction>
                ) : null}
                {onDownload ? (
                  <CardAction label={`Export ${theme.label}`} tooltip="Export theme file" onClick={onDownload}>
                    <UploadIcon />
                  </CardAction>
                ) : null}
                {onRemove ? (
                  <CardAction
                    destructive
                    label={variantNavigation ? `Remove themes from ${name}` : `Remove ${theme.label}`}
                    tooltip={variantNavigation ? "Remove themes" : "Remove theme"}
                    onClick={onRemove}
                  >
                    <Trash2Icon />
                  </CardAction>
                ) : null}
              </div>
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {variantNavigation
          ? "Use the first variants for light and dark"
          : cardModes.length > 1
            ? "Use for both light and dark"
            : `Use for ${cardModes[0]} mode only`}
      </TooltipPopup>
    </Tooltip>
  );
}

/** One orb per appearance for a collection; hovering or focusing it fans out the variants for that appearance. */
function VariantOrbs({ navigation }: { navigation: VariantNavigation }) {
  const [openMode, setOpenMode] = useState<ThemeAppearance | null>(null);
  const groups = (["light", "dark"] as const).map((mode) => {
    const options = navigation.options.filter((option) => option.preview.mode === mode);
    return { mode, options, selected: options.find((option) => option.activeModes.includes(mode)) ?? options[0] };
  });
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- closes the fan on Escape and when focus leaves; the orbs are the controls
    <div
      aria-label="Light and dark theme variants"
      className="relative h-20"
      role="group"
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpenMode(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpenMode(null);
      }}
      onMouseLeave={() => setOpenMode(null)}
    >
      {groups.map(({ mode, options, selected }) => {
        if (!selected) return null;
        const rootOffsetX = mode === "light" ? -52 : 52;
        const isOpen = openMode === mode;
        const isActive = selected.activeModes.includes(mode);
        const modeLabel = mode === "light" ? "Light" : "Dark";
        return (
          <div className="contents" key={mode}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={
                      options.length > 1
                        ? `Choose ${mode} variant, ${options.length} options, currently ${selected.label}`
                        : `Use ${mode} variant, currently ${selected.label}`
                    }
                    aria-pressed={isActive}
                    className="absolute top-2 left-1/2 z-20 flex size-14 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"
                    style={{ transform: `translateX(calc(-50% + ${rootOffsetX}px))` }}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      navigation.onSelectAndUse(selected.themeIndex, mode);
                    }}
                    onFocus={() => setOpenMode(mode)}
                    onMouseEnter={() => setOpenMode(mode)}
                  >
                    <ThemePreviewCircle colors={selected.preview.colors} mode={selected.preview.mode} />
                    {isActive ? (
                      <>
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-ring ring-inset"
                        />
                        <span className="pointer-events-none absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm">
                          {mode === "light" ? <SunIcon className="size-2.5" /> : <MoonIcon className="size-2.5" />}
                        </span>
                      </>
                    ) : null}
                  </button>
                }
              />
              <TooltipPopup>{`${modeLabel}: ${selected.label}`}</TooltipPopup>
            </Tooltip>
            <span
              className="pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 text-2xs font-medium text-foreground"
              style={{ marginLeft: rootOffsetX }}
            >
              <span className="truncate">{selected.label}</span>
              {options.length > 1 ? (
                <span className="shrink-0 rounded-full bg-muted px-1 text-3xs text-muted-foreground">
                  +{options.length - 1}
                </span>
              ) : null}
            </span>
            {options.length > 1
              ? options.map((option, index) => {
                  const progress = index / (options.length - 1) - 0.5;
                  const childOffsetX = rootOffsetX + progress * 68;
                  const childOffsetY = Math.abs(progress) * 10;
                  const optionActive = option.activeModes.includes(mode);
                  return (
                    <Tooltip key={option.label}>
                      <TooltipTrigger
                        render={
                          <button
                            aria-label={`Use ${option.label} for ${mode} mode${optionActive ? ", currently active" : ""}`}
                            aria-pressed={optionActive}
                            className={cn(
                              "absolute top-1 left-1/2 z-30 flex size-7 items-center justify-center rounded-full bg-background shadow-sm outline-none transition-[opacity,transform] duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
                              optionActive ? "ring-2 ring-ring ring-inset" : "ring-1 ring-border/70",
                            )}
                            style={{
                              opacity: isOpen ? 1 : 0,
                              pointerEvents: isOpen ? "auto" : "none",
                              transform: `translate(calc(-50% + ${isOpen ? childOffsetX : rootOffsetX}px), ${isOpen ? childOffsetY : 28}px) scale(${isOpen ? 1 : 0.55})`,
                              transitionDelay: isOpen ? `${index * 35}ms` : "0ms",
                            }}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              navigation.onSelectAndUse(option.themeIndex, mode);
                            }}
                            onFocus={() => setOpenMode(mode)}
                            onMouseEnter={() => setOpenMode(mode)}
                          >
                            <span className="pointer-events-none scale-[0.43]">
                              <ThemePreviewCircle colors={option.preview.colors} mode={option.preview.mode} />
                            </span>
                          </button>
                        }
                      />
                      <TooltipPopup>{`Use ${option.label} for ${mode} mode`}</TooltipPopup>
                    </Tooltip>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}

/** A custom theme's card, or one card for a whole collection with its variants on the orbs. */
function CustomThemeCollectionCard({
  themes,
  activeModesFor,
  onUse,
  onUseMode,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
}: {
  themes: ReadonlyArray<ThemeDefinition>;
  activeModesFor: (themeId: string) => ReadonlyArray<ThemeMode>;
  onUse: (theme: ThemeDefinition) => void;
  onUseMode: (theme: ThemeDefinition, mode: ThemeMode) => void;
  onDuplicate: (theme: ThemeDefinition) => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDownload: (theme: ThemeDefinition) => void;
  onRemove: (theme: ThemeDefinition) => void;
}) {
  // The card's buttons act on the variant last picked, starting with the one in use.
  const [variantIndex, setVariantIndex] = useState(() =>
    Math.max(
      0,
      themes.findIndex((theme) => activeModesFor(theme.id).length > 0),
    ),
  );
  const theme = themes[Math.min(variantIndex, themes.length - 1)];
  if (!theme) return null;

  const labels = collectionVariantLabels(themes);
  const useDefaults = () => {
    if (themes.length === 1) {
      onUse(theme);
      return;
    }
    const light = themes.find((candidate) => getThemeModes(candidate).includes("light"));
    const dark = themes.find((candidate) => getThemeModes(candidate).includes("dark"));
    if (light) onUseMode(light, "light");
    if (dark) onUseMode(dark, "dark");
    setVariantIndex(0);
  };

  return (
    <ThemeCard
      activeModes={activeModesFor(theme.id)}
      onDownload={() => onDownload(theme)}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onRemove={() => onRemove(theme)}
      onUse={useDefaults}
      onUseMode={(mode) => onUseMode(theme, mode)}
      theme={getThemeCardDefinition(theme)}
      {...(themes.length > 1
        ? {
            variantNavigation: {
              collectionLabel: theme.collection?.label ?? theme.label,
              options: themes.flatMap((variant, themeIndex) =>
                getThemeCardDefinition(variant).previews.map((preview) => ({
                  themeIndex,
                  label: labels[themeIndex] ?? variant.label,
                  activeModes: activeModesFor(variant.id),
                  preview,
                })),
              ),
              onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => {
                const selected = themes[themeIndex];
                if (!selected) return;
                setVariantIndex(themeIndex);
                onUseMode(selected, mode);
              },
            },
          }
        : {})}
    />
  );
}
