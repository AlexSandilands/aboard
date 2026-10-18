// Theme resolution adapted from T3 Code (apps/web/src/themePalette.ts, hooks/useTheme.ts), MIT — see NOTICE.
import {
  APP_THEME_VARIABLES,
  BUILT_IN_THEMES,
  getThemeColorsForAppearance,
  getThemeModes,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "./palettes";

/** The appearance the user picked; "system" follows the OS. */
export type ThemeMode = ThemeAppearance | "system";

/** A theme per appearance, set by clicking one orb on a card. A half that is unset falls back to the base theme. */
export type ThemeHalves = Readonly<{ light?: string; dark?: string }>;

/**
 * Everything the user chose, as saved. `themeId` null is the default T3 Code theme, which is the board's own CSS
 * tokens, so nothing is applied for it.
 */
export interface ThemeSelection {
  mode: ThemeMode;
  themeId: string | null;
  halves: ThemeHalves;
}

export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function findTheme(
  id: string | null | undefined,
  custom: ReadonlyArray<ThemeDefinition>,
): ThemeDefinition | null {
  if (!id) return null;
  return BUILT_IN_THEMES.find((t) => t.id === id) ?? custom.find((t) => t.id === id) ?? null;
}

/** A saved base theme id, or null when it names no theme we have (a removed custom theme falls back to T3 Code). */
export function parseThemeId(raw: string | null, custom: ReadonlyArray<ThemeDefinition>): string | null {
  return findTheme(raw, custom)?.id ?? null;
}

/** Keeps only the halves that name a theme with colours for that appearance. */
export function parseThemeHalves(raw: string | null, custom: ReadonlyArray<ThemeDefinition>): ThemeHalves {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const halves: { light?: string; dark?: string } = {};
  for (const appearance of ["light", "dark"] as const) {
    const theme = findTheme((value as Record<string, unknown>)[appearance] as string | undefined, custom);
    if (theme && getThemeColorsForAppearance(theme, appearance)) halves[appearance] = theme.id;
  }
  return halves;
}

export function wantedAppearance(mode: ThemeMode, systemDark: boolean): ThemeAppearance {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

/**
 * The appearance actually shown. Usually the one the mode asks for, but a base theme with colours for only one
 * appearance (a custom theme can be light-only) forces its own, unless a half covers the one asked for.
 */
export function resolveThemeAppearance(
  selection: ThemeSelection,
  systemDark: boolean,
  custom: ReadonlyArray<ThemeDefinition>,
): ThemeAppearance {
  return appearanceFor(selection, wantedAppearance(selection.mode, systemDark), custom);
}

function appearanceFor(
  selection: ThemeSelection,
  wanted: ThemeAppearance,
  custom: ReadonlyArray<ThemeDefinition>,
): ThemeAppearance {
  if (selection.halves[wanted]) return wanted;
  const base = findTheme(selection.themeId, custom);
  return base && !getThemeColorsForAppearance(base, wanted) ? base.appearance : wanted;
}

/** The theme that owns each appearance (null is T3 Code); drives the rings and badges on the cards. */
export function themeOwners(
  selection: ThemeSelection,
  custom: ReadonlyArray<ThemeDefinition>,
): Record<ThemeAppearance, string | null> {
  const base = findTheme(selection.themeId, custom)?.id ?? null;
  return { light: selection.halves.light ?? base, dark: selection.halves.dark ?? base };
}

export interface ActiveTheme {
  theme: ThemeDefinition;
  appearance: ThemeAppearance;
  colors: ThemeColors;
}

/** The palette to apply for an appearance, or null for the default T3 Code theme. */
export function resolveActiveTheme(
  selection: ThemeSelection,
  appearance: ThemeAppearance,
  custom: ReadonlyArray<ThemeDefinition>,
): ActiveTheme | null {
  const theme = findTheme(themeOwners(selection, custom)[appearance], custom);
  if (!theme) return null;
  return { theme, appearance, colors: getThemeColorsForAppearance(theme, appearance) ?? theme.colors };
}

/**
 * What the desktop shell's nativeTheme should follow: "system" only when both appearances are covered, otherwise the
 * one appearance a single-appearance theme forces.
 */
export function resolveDesktopTheme(selection: ThemeSelection, custom: ReadonlyArray<ThemeDefinition>): ThemeMode {
  if (selection.mode !== "system") return appearanceFor(selection, selection.mode, custom);
  const light = appearanceFor(selection, "light", custom);
  const dark = appearanceFor(selection, "dark", custom);
  return light === dark ? light : "system";
}

/**
 * Clicking a card: the theme takes both appearances. A theme with only one appearance takes just that half, so the
 * other keeps what it had.
 */
export function selectWholeTheme(
  selection: ThemeSelection,
  themeId: string | null,
  custom: ReadonlyArray<ThemeDefinition>,
): ThemeSelection {
  const theme = findTheme(themeId, custom);
  const modes = theme ? getThemeModes(theme) : [];
  if (theme && modes.length === 1) return selectThemeHalf(selection, modes[0]!, theme.id, custom);
  return { ...selection, themeId: theme?.id ?? null, halves: {} };
}

/** Clicking one orb: the theme takes only that appearance. */
export function selectThemeHalf(
  selection: ThemeSelection,
  appearance: ThemeAppearance,
  themeId: string | null,
  custom: ReadonlyArray<ThemeDefinition>,
): ThemeSelection {
  const other: ThemeAppearance = appearance === "light" ? "dark" : "light";
  const base = findTheme(selection.themeId, custom)?.id ?? null;
  // T3 Code over a themed base can't be a half: the base would still own this appearance. Turn the base into an
  // explicit half on the other side and clear it, so this side falls back to T3 Code.
  if (themeId === null && base !== null) {
    const otherOwner = selection.halves[other] ?? base;
    return { ...selection, themeId: null, halves: { [other]: otherOwner } };
  }
  const halves: { light?: string; dark?: string } = { ...selection.halves };
  if (themeId === null) delete halves[appearance];
  else halves[appearance] = themeId;
  return { ...selection, halves };
}

/** One appearance's palette as the index.html boot script reads it: the variables to set, already named. */
export interface PaintEntry {
  appearance: ThemeAppearance;
  id: string | null;
  /** The theme's canvas, painted on `<html>`; null for T3 Code, whose background the script knows. */
  background: string | null;
  vars: Record<string, string> | null;
}

/**
 * The resolved theme for each appearance the mode can ask for, saved so the boot script can paint the right colours
 * before React (and the palettes) load. Keyed by the wanted appearance; `appearance` is what is actually shown.
 */
export type PaintSnapshot = Record<ThemeAppearance, PaintEntry>;

export function buildPaintSnapshot(selection: ThemeSelection, custom: ReadonlyArray<ThemeDefinition>): PaintSnapshot {
  const entry = (wanted: ThemeAppearance): PaintEntry => {
    const appearance = appearanceFor(selection, wanted, custom);
    const active = resolveActiveTheme(selection, appearance, custom);
    if (!active) return { appearance, id: null, background: null, vars: null };
    const vars: Record<string, string> = {};
    for (const [role, value] of Object.entries(active.colors) as Array<[ThemeColorRole, string]>) {
      vars[APP_THEME_VARIABLES[role]] = value;
    }
    return { appearance, id: active.theme.id, background: active.colors.canvas, vars };
  };
  return { light: entry("light"), dark: entry("dark") };
}
