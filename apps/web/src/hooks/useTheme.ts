// Adapted from T3 Code (apps/web/src/hooks/useTheme.ts), MIT — see NOTICE.
// The appearance mode, the base theme, the light/dark halves and custom themes, all kept in this browser. The
// index.html boot script reads the mode and the paint snapshot written here.
import { storageKey } from "@repo/contracts";
import { useSyncExternalStore } from "react";
import { desktopBridge } from "~/lib/desktopBridge";
import { applyThemePalette, DEFAULT_BACKGROUND, toHexColor } from "~/theme/applyTheme";
import type { ThemeAppearance, ThemeDefinition } from "~/theme/palettes";
import { parseStoredThemes } from "~/theme/themeFile";
import {
  buildPaintSnapshot,
  DEFAULT_THEME_MODE,
  isThemeMode,
  parseThemeHalves,
  parseThemeId,
  resolveActiveTheme,
  resolveDesktopTheme,
  resolveThemeAppearance,
  selectThemeHalf,
  selectWholeTheme,
  type ThemeHalves,
  type ThemeMode,
  type ThemeSelection,
} from "~/theme/themeState.logic";

/** The appearance mode. Kept under the name callers already use. */
export type Theme = ThemeMode;

const MODE_KEY = storageKey("theme");
const THEME_ID_KEY = storageKey("theme-id");
const HALVES_KEY = storageKey("theme-halves");
const CUSTOM_THEMES_KEY = storageKey("themes");
/** Read by the boot script in index.html; see buildPaintSnapshot. */
export const THEME_PAINT_KEY = storageKey("theme-paint");
const KEYS = new Set([MODE_KEY, THEME_ID_KEY, HALVES_KEY, CUSTOM_THEMES_KEY]);
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners: Array<() => void> = [];

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the choice still applies for this session.
  }
}

let customCache: { raw: string | null; themes: ThemeDefinition[] } = { raw: null, themes: [] };

function readCustomThemes(): ThemeDefinition[] {
  const raw = read(CUSTOM_THEMES_KEY);
  if (raw !== customCache.raw) customCache = { raw, themes: parseStoredThemes(raw) };
  return customCache.themes;
}

function readSelection(custom: ReadonlyArray<ThemeDefinition>): ThemeSelection {
  const mode = read(MODE_KEY);
  return {
    mode: isThemeMode(mode) ? mode : DEFAULT_THEME_MODE,
    themeId: parseThemeId(read(THEME_ID_KEY), custom),
    halves: parseThemeHalves(read(HALVES_KEY), custom),
  };
}

function writeSelection(selection: ThemeSelection) {
  write(MODE_KEY, selection.mode);
  write(THEME_ID_KEY, selection.themeId);
  const { light, dark } = selection.halves;
  write(HALVES_KEY, light || dark ? JSON.stringify(selection.halves) : null);
}

function systemDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

export interface ThemeSnapshot {
  /** The appearance mode: light, dark or system. */
  theme: Theme;
  resolvedTheme: ThemeAppearance;
  themeId: string | null;
  themeHalves: ThemeHalves;
  customThemes: ReadonlyArray<ThemeDefinition>;
}

const SERVER_SNAPSHOT: ThemeSnapshot = {
  theme: DEFAULT_THEME_MODE,
  resolvedTheme: "dark",
  themeId: null,
  themeHalves: {},
  customThemes: [],
};
let lastSnapshot: ThemeSnapshot = SERVER_SNAPSHOT;

function getSnapshot(): ThemeSnapshot {
  const customThemes = readCustomThemes();
  const selection = readSelection(customThemes);
  const next: ThemeSnapshot = {
    theme: selection.mode,
    resolvedTheme: resolveThemeAppearance(selection, systemDark(), customThemes),
    themeId: selection.themeId,
    themeHalves: selection.halves,
    customThemes,
  };
  const prev = lastSnapshot;
  if (
    prev.theme === next.theme &&
    prev.resolvedTheme === next.resolvedTheme &&
    prev.themeId === next.themeId &&
    prev.themeHalves.light === next.themeHalves.light &&
    prev.themeHalves.dark === next.themeHalves.dark &&
    prev.customThemes === next.customThemes
  ) {
    return prev;
  }
  lastSnapshot = next;
  return next;
}

/** Tells the desktop shell which appearance its native controls should use and what colour to paint behind the page. */
function reportToDesktop(selection: ThemeSelection, custom: ReadonlyArray<ThemeDefinition>, background: string) {
  const bridge = desktopBridge();
  if (!bridge) return;
  bridge.setTheme(resolveDesktopTheme(selection, custom));
  const hex = toHexColor(background);
  // An older shell's preload has no setBackgroundColor.
  if (hex) bridge.setBackgroundColor?.(hex);
}

function applyCurrent(suppressTransitions: boolean) {
  const custom = readCustomThemes();
  const selection = readSelection(custom);
  const appearance = resolveThemeAppearance(selection, systemDark(), custom);
  const active = resolveActiveTheme(selection, appearance, custom);
  const root = document.documentElement;
  if (suppressTransitions) root.classList.add("no-transitions");
  const dark = appearance === "dark";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  applyThemePalette(root, active);
  const background = active?.colors.canvas ?? DEFAULT_BACKGROUND[appearance];
  root.style.backgroundColor = background;
  write(THEME_PAINT_KEY, JSON.stringify(buildPaintSnapshot(selection, custom)));
  reportToDesktop(selection, custom, background);
  if (suppressTransitions) {
    // Force a reflow so no-transitions applies before it is removed.
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

/**
 * Called once at startup. index.html painted from the snapshot, but the snapshot may be missing (first run) or stale
 * (a theme changed shape in an update), and the shell hasn't heard the theme yet.
 */
export function initTheme() {
  applyCurrent(false);
}

function emit() {
  for (const listener of listeners) listener();
}

function onSystem() {
  applyCurrent(true);
  emit();
}

function onStorage(event: StorageEvent) {
  if (event.key !== null && !KEYS.has(event.key)) return;
  applyCurrent(true);
  emit();
}

// The window listeners are shared: one per subscriber would re-apply (and write storage, and message the shell)
// once for every component using the hook.
let systemQuery: MediaQueryList | null = null;

function subscribe(listener: () => void) {
  if (listeners.length === 0) {
    systemQuery = window.matchMedia(MEDIA_QUERY);
    systemQuery.addEventListener("change", onSystem);
    window.addEventListener("storage", onStorage);
  }
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0) {
      systemQuery?.removeEventListener("change", onSystem);
      systemQuery = null;
      window.removeEventListener("storage", onStorage);
    }
  };
}

function update(change: (selection: ThemeSelection, custom: ReadonlyArray<ThemeDefinition>) => ThemeSelection) {
  const custom = readCustomThemes();
  writeSelection(change(readSelection(custom), custom));
  applyCurrent(true);
  emit();
}

const setTheme = (mode: Theme) => update((s) => ({ ...s, mode }));
/** Clicking a card: the theme (null for T3 Code) takes both appearances. */
const setThemeId = (themeId: string | null) => update((s, custom) => selectWholeTheme(s, themeId, custom));
/** Clicking one orb: the theme takes only that appearance. */
const setThemeHalf = (appearance: ThemeAppearance, themeId: string | null) =>
  update((s, custom) => selectThemeHalf(s, appearance, themeId, custom));

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  return { ...snapshot, setTheme, setThemeId, setThemeHalf } as const;
}
