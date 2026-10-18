// Adapted from T3 Code (apps/web/src/components/settings/ThemeEditorPanel.tsx), MIT — see NOTICE. The floating theme
// editor: it previews the draft on the whole board while open, so it is a movable panel rather than a dialog.
import { ChevronDownIcon, ChevronUpIcon, MousePointer2Icon, PaintbrushIcon, PlusIcon, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { customThemeLibrary, endThemePreview, previewThemeColors, useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { isThemeColor } from "~/theme/color";
import { updateThemeColorFamily } from "~/theme/derive";
import {
  getThemeModes,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "~/theme/palettes";
import { ThemeColorField } from "./ThemeColorPicker";
import {
  appearanceLockReason,
  buildEditedTheme,
  buildNewTheme,
  filterThemeEditorGroups,
  findMergeTarget,
  getManagedEditorColors,
  getThemeEditorColorFamily,
  getThemeRoleLabel,
  mergeIntoTheme,
  seedThemeEditor,
  THEME_EDITOR_SIMPLE_ROLES,
  type ThemeEditorColorFamily,
  type ThemeEditorColorsByAppearance,
} from "./themeEditor.logic";
import {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  inspectThemeRoleFromUtilitiesAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from "./themeInspector";

const MARGIN = 8;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;

function clampPanelPosition(panel: HTMLElement | null, x: number, y: number, widthOverride?: number) {
  // The caller passes a width when it has just shrunk the panel: the DOM still reports the old one until React commits.
  const width = widthOverride ?? panel?.offsetWidth ?? 0;
  return {
    x: Math.min(Math.max(x, MARGIN), Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    y: Math.min(Math.max(y, MARGIN), Math.max(MARGIN, window.innerHeight - 48)),
  };
}

/** Where a saved draft went, for the host's toast and theme selection. */
export type ThemeSaveResult = { created: boolean; mergedAppearance?: ThemeAppearance };

export function ThemeEditorPanel({
  onClose,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
}: {
  onClose: () => void;
  onSaved: (theme: ThemeDefinition, result: ThemeSaveResult) => void;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  seedTheme: ThemeDefinition | null;
  seedName: string | null;
}) {
  const { customThemes } = useTheme();
  const isEditing = editingTheme !== null;
  // The host remounts the panel per session (keyed by its id), so the seed is read once here.
  const [seed] = useState(() => seedThemeEditor(editingTheme ?? seedTheme, initialAppearance));
  const [name, setName] = useState(editingTheme?.label ?? seedName ?? "");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(seed.appearance);
  const [isAdvanced, setIsAdvanced] = useState(seed.advanced);
  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(seed.colors);
  // Simple-mode drafts are re-derived on save only for the appearances whose two colours were touched.
  const [simpleDirty, setSimpleDirty] = useState<Record<ThemeAppearance, boolean>>({ light: false, dark: false });
  // Leaving advanced mode re-derives the palette from its two colours only once something was hand-edited.
  const [shouldRegenerate, setShouldRegenerate] = useState(seed.advanced);
  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null);
  const [usageCount, setUsageCount] = useState<number | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    const clamp = () => {
      let clampedWidth: number | undefined;
      let clampedHeight: number | undefined;
      setSize((current) => {
        if (!current) return current;
        clampedWidth = Math.max(MIN_WIDTH, Math.min(current.width, window.innerWidth - MARGIN * 2));
        clampedHeight = Math.max(MIN_HEIGHT, Math.min(current.height, window.innerHeight - MARGIN * 2));
        return { width: clampedWidth, height: clampedHeight };
      });
      setPosition((current) => {
        if (!current) return current;
        const clamped = clampPanelPosition(panelRef.current, current.x, current.y, clampedWidth);
        const height = isMinimized
          ? (panelRef.current?.offsetHeight ?? 0)
          : (clampedHeight ?? panelRef.current?.offsetHeight ?? 0);
        const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
        return { x: clamped.x, y: Math.min(clamped.y, maxY) };
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [isMinimized]);

  const mergeTarget = findMergeTarget(name, customThemes, editingTheme?.id ?? null);
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  const lockReason = (appearance: ThemeAppearance) => appearanceLockReason(appearance, editingTheme, mergeTarget);

  // Typing the name of a theme that already has this appearance moves to the other one, once per target.
  const mergeKey = isEditing || mergeTarget === null ? null : `${mergeTarget.id}:${takenAppearances.join(",")}`;
  const [appliedMergeKey, setAppliedMergeKey] = useState<string | null>(null);
  if (appliedMergeKey !== mergeKey) {
    setAppliedMergeKey(mergeKey);
    if (mergeKey !== null && takenAppearances.length === 1 && takenAppearances.includes(activeAppearance)) {
      setActiveAppearance(takenAppearances[0] === "light" ? "dark" : "light");
    }
  }

  useEffect(() => {
    previewThemeColors(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance]);

  // Closing for any reason (Cancel, ×, a save) puts the saved theme back.
  useEffect(() => endThemePreview, []);

  const updateColor = (role: ThemeColorRole, value: string) => {
    const simpleRole = !isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeColor(value);
    setColorsByAppearance((current) => {
      const colors = current[activeAppearance];
      const next = isAdvanced
        ? updateThemeColorFamily(activeAppearance, colors, role, value)
        : simpleRole
          ? getManagedEditorColors(activeAppearance, { ...colors, [role]: value })
          : { ...colors, [role]: value };
      return { ...current, [activeAppearance]: next };
    });
    if (simpleRole) setSimpleDirty((current) => ({ ...current, [activeAppearance]: true }));
    if (isAdvanced) setShouldRegenerate(true);
  };

  const selectThemeRole = (role: ThemeColorRole, reveal = false) => {
    const visibleRole = getThemeEditorColorFamily(role)?.role ?? role;
    setSelectedRole(visibleRole);
    if (!THEME_EDITOR_SIMPLE_ROLES.includes(visibleRole)) {
      setIsAdvanced(true);
      setRoleQuery("");
    }
    if (!reveal) return;
    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector(`[data-theme-color-role="${visibleRole}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };

  const toggleThemeRole = (role: ThemeColorRole) => setSelectedRole((current) => (current === role ? null : role));

  const clearInspectorSelection = () => {
    setSelectedRole(null);
    setUsageCount(null);
    setIsInspecting(false);
  };

  const activeColors = colorsByAppearance[activeAppearance];
  // Advanced mode highlights the family; simple mode every role that ended up with the same colour.
  const selectedHighlightRoles: ReadonlyArray<ThemeColorRole> = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.roles ?? [selectedRole])
      : THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)
        ? THEME_COLOR_ROLES.filter(
            (role) => activeColors[role].trim().toLowerCase() === activeColors[selectedRole].trim().toLowerCase(),
          )
        : [selectedRole]
    : [];
  const selectedHighlightRolesKey = selectedHighlightRoles.join(",");

  useEffect(() => {
    clearThemeInspectorHighlights();
    if (selectedHighlightRolesKey === "" || isInspecting) return;

    const highlightedRoles = selectedHighlightRolesKey.split(",") as Array<ThemeColorRole>;
    const refreshHighlights = () => setUsageCount(highlightThemeRoleUsage(highlightedRoles));
    refreshHighlights();
    // A refresh snapshots computed styles for the whole tree twice, so it is throttled rather than run per frame: live
    // updates mutate the DOM continuously and would otherwise stall the main thread while the editor is open.
    const MIN_REFRESH_INTERVAL_MS = 500;
    let refreshFrame: number | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = performance.now();
    const scheduleRefresh = () => {
      if (refreshFrame !== null || refreshTimer !== null) return;
      const wait = Math.max(0, MIN_REFRESH_INTERVAL_MS - (performance.now() - lastRefreshAt));
      const run = () => {
        refreshFrame = null;
        refreshTimer = null;
        lastRefreshAt = performance.now();
        refreshHighlights();
      };
      if (wait === 0) refreshFrame = requestAnimationFrame(run);
      else refreshTimer = setTimeout(run, wait);
    };
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.every(
          (mutation) =>
            mutation.target instanceof Element &&
            (mutation.target.closest("#theme-inspector-spotlight") ||
              mutation.target.closest("[data-theme-editor-panel]")),
        )
      ) {
        return;
      }
      scheduleRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    let spotlightFrame: number | null = null;
    const scheduleSpotlightRefresh = () => {
      if (spotlightFrame !== null) return;
      spotlightFrame = requestAnimationFrame(() => {
        spotlightFrame = null;
        refreshThemeInspectorSpotlight();
      });
    };
    window.addEventListener("resize", scheduleSpotlightRefresh);
    window.addEventListener("scroll", scheduleSpotlightRefresh, true);
    return () => {
      observer.disconnect();
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame);
      window.removeEventListener("resize", scheduleSpotlightRefresh);
      window.removeEventListener("scroll", scheduleSpotlightRefresh, true);
      clearThemeInspectorHighlights();
      setUsageCount(null);
    };
  }, [isInspecting, selectedHighlightRolesKey]);

  const onInspected = useEffectEvent((role: ThemeColorRole) => selectThemeRole(role, true));
  const onInspectCancelled = useEffectEvent(() => clearInspectorSelection());

  useEffect(() => {
    if (!isInspecting) {
      clearThemeInspectorHover();
      return;
    }

    let shouldDisarmAfterClick = false;
    let hoverTarget: Element | null = null;
    let hoverInspection: ThemeElementInspection | null = null;
    let hoverTimer: number | null = null;
    let hoverFrame: number | null = null;
    const labelOf = (role: ThemeColorRole) => getThemeEditorColorFamily(role)?.label ?? getThemeRoleLabel(role);
    const clearHoverTimer = () => {
      if (hoverTimer === null) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const clearHover = () => {
      clearHoverTimer();
      hoverTarget = null;
      hoverInspection = null;
      clearThemeInspectorHover();
    };
    const showInspection = (inspection: ThemeElementInspection) => {
      hoverInspection = inspection;
      showThemeInspectorHover(inspection, labelOf(inspection.role));
    };
    const handlePointerOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) {
        clearHover();
        return;
      }
      clearHoverTimer();
      hoverTarget = target;
      hoverInspection = null;
      const utilityInspection = inspectThemeRoleFromUtilitiesAtElement(target);
      if (utilityInspection) {
        showInspection(utilityInspection);
        return;
      }
      // Probing every role is slow, so it waits until the pointer rests.
      clearThemeInspectorHover();
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverTarget !== target || !target.isConnected) return;
        const inspection = inspectThemeRoleAtElement(target);
        if (inspection) showInspection(inspection);
      }, 140);
    };
    const handlePointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) clearHover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      clearHoverTimer();
      const inspection =
        hoverTarget === target && hoverInspection ? hoverInspection : inspectThemeRoleAtElement(target);
      if (!inspection) return;
      clearHover();
      onInspected(inspection.role);
      shouldDisarmAfterClick = true;
    };
    // The click that picked a colour mustn't also open the card or press the button under it.
    const blockInspectedClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-theme-editor-panel]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (shouldDisarmAfterClick) setIsInspecting(false);
      shouldDisarmAfterClick = false;
    };
    const cancelInspection = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape would otherwise also close the task panel or leave Settings.
      event.preventDefault();
      event.stopPropagation();
      clearHover();
      onInspectCancelled();
    };
    const refreshHover = () => {
      if (!hoverInspection || hoverFrame !== null) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = null;
        if (hoverInspection) showThemeInspectorHover(hoverInspection, labelOf(hoverInspection.role));
      });
    };
    const clearHoverOnScroll = () => clearHover();

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("click", blockInspectedClick, true);
    document.addEventListener("keydown", cancelInspection, true);
    window.addEventListener("resize", refreshHover);
    window.addEventListener("scroll", clearHoverOnScroll, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("click", blockInspectedClick, true);
      document.removeEventListener("keydown", cancelInspection, true);
      window.removeEventListener("resize", refreshHover);
      window.removeEventListener("scroll", clearHoverOnScroll, true);
      clearHoverTimer();
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
      clearThemeInspectorHover();
    };
  }, [isInspecting]);

  const handleAdvancedChange = (checked: boolean) => {
    setIsAdvanced(checked);
    if (checked) return;
    if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) setSelectedRole(null);
    if (!shouldRegenerate) return;
    const managed: ReadonlyArray<ThemeAppearance> =
      editingTheme && getThemeModes(editingTheme).length > 1 ? ["light", "dark"] : [activeAppearance];
    setSimpleDirty((current) => {
      const next = { ...current };
      for (const appearance of managed) next[appearance] = true;
      return next;
    });
    setColorsByAppearance((current) => {
      const next = { ...current };
      for (const appearance of managed) next[appearance] = getManagedEditorColors(appearance, current[appearance]);
      return next;
    });
    setShouldRegenerate(false);
  };

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name your theme first.");
      return;
    }
    const managed = !isAdvanced;
    const colors: ThemeEditorColorsByAppearance = managed
      ? {
          light: simpleDirty.light
            ? getManagedEditorColors("light", colorsByAppearance.light)
            : colorsByAppearance.light,
          dark: simpleDirty.dark ? getManagedEditorColors("dark", colorsByAppearance.dark) : colorsByAppearance.dark,
        }
      : colorsByAppearance;

    try {
      if (editingTheme && mergeTarget) {
        // Renaming a theme to another theme's name folds its palettes into that one.
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));
        if (collision) {
          setError(`“${mergeTarget.label}” already has a ${collision} palette. Pick another name.`);
          return;
        }
        const saved = customThemeLibrary.update(
          mergeIntoTheme(mergeTarget, Object.fromEntries(editedModes.map((mode) => [mode, colors[mode]])), managed),
        );
        try {
          customThemeLibrary.remove([editingTheme.id]);
        } catch (cause) {
          // Leaving both would collide on every retry, so the target goes back to how it was.
          try {
            customThemeLibrary.update(mergeTarget);
          } catch {
            // Nothing more to undo with; the first error is the one to show.
          }
          throw cause;
        }
        onSaved(saved, { created: false, ...(editedModes[0] ? { mergedAppearance: editedModes[0] } : {}) });
      } else if (editingTheme) {
        onSaved(customThemeLibrary.update(buildEditedTheme(editingTheme, name, colors, managed)), { created: false });
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(`“${mergeTarget.label}” already has light and dark palettes. Pick another name.`);
          return;
        }
        const saved = customThemeLibrary.update(
          mergeIntoTheme(mergeTarget, { [activeAppearance]: colors[activeAppearance] }, managed),
        );
        onSaved(saved, { created: false, mergedAppearance: activeAppearance });
      } else {
        onSaved(customThemeLibrary.install(buildNewTheme(name, activeAppearance, colors[activeAppearance], managed)), {
          created: true,
        });
      }
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEditing
            ? "Could not save the theme."
            : "Could not create the theme.",
      );
    }
  };

  const renderAppearanceButton = (appearance: ThemeAppearance) => {
    const reason = lockReason(appearance);
    // A locked mode stays hoverable so the tooltip can say why it is off; a real disabled attribute would swallow the
    // pointer events.
    const button = (
      <Toggle aria-disabled={reason !== null} value={appearance}>
        {appearance === "light" ? "Light" : "Dark"}
      </Toggle>
    );
    if (reason === null) return button;
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup data-theme-editor-panel="">{reason}</TooltipPopup>
      </Tooltip>
    );
  };

  const renderField = (family: Pick<ThemeEditorColorFamily, "role" | "label">) => (
    <ThemeColorField
      key={family.role}
      label={family.label}
      onChange={updateColor}
      onSelect={selectThemeRole}
      onToggleSelected={toggleThemeRole}
      role={family.role}
      selected={selectedRole === family.role}
      value={activeColors[family.role]}
    />
  );

  const renderColorFields = () => {
    if (!isAdvanced) {
      return (
        <div className="grid gap-1">
          {THEME_EDITOR_SIMPLE_ROLES.map((role) =>
            renderField({ role, label: role === "canvas" ? "Background" : "Accent" }),
          )}
        </div>
      );
    }
    const groups = filterThemeEditorGroups(roleQuery);
    return (
      <div className="space-y-5">
        {groups.map((group) => (
          <section className="space-y-2" key={group.id}>
            <h4 className="text-sm font-medium text-foreground">{group.title}</h4>
            <div className="grid gap-1">{group.families.map(renderField)}</div>
          </section>
        ))}
        {groups.length === 0 ? <p className="text-xs text-muted-foreground">No matches.</p> : null}
      </div>
    );
  };

  const clampPosition = (x: number, y: number) => clampPanelPosition(panelRef.current, x, y);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (offset) setPosition(clampPosition(event.clientX - offset.dx, event.clientY - offset.dy));
  };
  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    // The grip drags the bottom-right corner, so the top-left must hold still; the default spot is anchored
    // bottom-right and would slide, so it becomes an explicit position first.
    if (position === null) setPosition(clampPosition(rect.x, rect.y));
    resizeStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - MARGIN - start.left);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - MARGIN - start.top);
    setSize({
      width: Math.min(Math.max(start.width + event.clientX - start.pointerX, MIN_WIDTH), maxWidth),
      height: Math.min(Math.max(start.height + event.clientY - start.pointerY, MIN_HEIGHT), maxHeight),
    });
  };
  const endResize = () => {
    resizeStartRef.current = null;
  };

  const selectedLabel = selectedRole
    ? isAdvanced
      ? (getThemeEditorColorFamily(selectedRole)?.label ?? getThemeRoleLabel(selectedRole))
      : getThemeRoleLabel(selectedRole)
    : null;

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only stops Escape from reaching the app's shortcuts
    <div
      aria-label={isEditing ? "Edit theme" : "Create theme"}
      className={cn(
        "dialog-glass fixed z-[110] flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border text-popover-foreground",
        position === null && "right-4 bottom-4",
        isMinimized && "max-h-none",
      )}
      data-theme-editor-panel
      ref={panelRef}
      role="dialog"
      style={{
        ...(position ? { left: position.x, top: position.y } : {}),
        ...(size ? { width: size.width } : {}),
        ...(size && !isMinimized ? { height: size.height, maxHeight: "calc(100dvh - 1rem)" } : {}),
      }}
      onKeyDown={(event) => {
        // Escape inside the editor shouldn't reach the app's shortcuts (leave Settings, close the task panel).
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- the title bar is a pointer drag handle; the panel's controls are keyboard reachable */}
      <div
        className="flex cursor-grab touch-none items-center gap-1 border-b border-border/70 px-3 py-2 select-none active:cursor-grabbing"
        onPointerCancel={endDrag}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={endDrag}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 truncate text-sm font-medium">{isEditing ? "Edit theme" : "Create theme"}</h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {isInspecting
                ? "Select an element · Esc to cancel"
                : selectedLabel
                  ? `${selectedLabel} · ${usageCount ?? 0} ${usageCount === 1 ? "use" : "uses"}`
                  : "Select a color below"}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={isInspecting ? "Cancel inspecting board colors" : "Inspect board colors"}
                aria-pressed={isInspecting}
                size="xs"
                variant={isInspecting ? "secondary" : "ghost"}
                onClick={() => (isInspecting ? clearInspectorSelection() : setIsInspecting(true))}
              >
                <MousePointer2Icon />
                {isInspecting ? "Cancel" : "Inspect"}
              </Button>
            }
          />
          <TooltipPopup data-theme-editor-panel="">
            {isInspecting ? "Cancel and clear the selection" : "Pick a color from the board"}
          </TooltipPopup>
        </Tooltip>
        <Button
          aria-label={isMinimized ? "Expand the theme editor" : "Minimize the theme editor"}
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMinimized(!isMinimized)}
        >
          {isMinimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button aria-label="Close the theme editor" size="icon-xs" variant="ghost" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      {isMinimized ? null : (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3 pr-1.5 pl-3">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
              <label className="text-sm font-medium" htmlFor="theme-editor-name">
                Theme name
              </label>
              <Input
                id="theme-editor-name"
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the editor opens to name the theme, as in T3 Code
                autoFocus
                size="sm"
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
                placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
                value={name}
              />
            </div>
            {error ? (
              <p aria-live="polite" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
              <span className="text-sm font-medium">Appearance</span>
              <ToggleGroup
                aria-label="Theme appearance"
                variant="segmented"
                value={[activeAppearance]}
                onValueChange={(next) => {
                  const appearance = next[0];
                  if ((appearance === "light" || appearance === "dark") && lockReason(appearance) === null) {
                    setActiveAppearance(appearance);
                  }
                }}
              >
                {renderAppearanceButton("light")}
                {renderAppearanceButton("dark")}
              </ToggleGroup>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
                <div>
                  <h3 className="text-sm font-medium">Colors</h3>
                  {isAdvanced ? null : <p className="text-xs text-muted-foreground">Two colors, rest derived</p>}
                </div>
                <div className="flex min-w-0 items-start gap-3">
                  {isAdvanced ? (
                    <Input
                      aria-label="Filter colors"
                      className="min-w-0 flex-1"
                      onChange={(event) => setRoleQuery(event.currentTarget.value)}
                      placeholder="Filter colors"
                      size="sm"
                      value={roleQuery}
                    />
                  ) : null}
                  <div className="ml-auto flex shrink-0 items-center gap-2 pt-0.5 text-sm font-medium">
                    <label className="cursor-pointer" htmlFor="theme-editor-advanced">
                      Advanced
                    </label>
                    <Switch
                      id="theme-editor-advanced"
                      aria-label="Use advanced theme colors"
                      checked={isAdvanced}
                      onCheckedChange={handleAdvancedChange}
                    />
                  </div>
                </div>
              </div>
              {renderColorFields()}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                mergeTarget ? (
                  `Merge into “${mergeTarget.label}”`
                ) : (
                  "Save changes"
                )
              ) : mergeTarget ? (
                <>
                  <PlusIcon />
                  {`Add ${activeAppearance} palette`}
                </>
              ) : (
                <>
                  <PaintbrushIcon />
                  Create theme
                </>
              )}
            </Button>
          </div>
          <div
            aria-hidden
            className="absolute right-0 bottom-0 z-10 flex size-5 cursor-se-resize touch-none items-end justify-end p-1 text-muted-foreground/70 select-none"
            onPointerCancel={endResize}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
          >
            <svg
              aria-hidden
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.2"
              viewBox="0 0 8 8"
            >
              <path d="M7 1 1 7M7 4.5 4.5 7" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
