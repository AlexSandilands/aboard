// Adapted from T3 Code (apps/web/src/themePalette.ts), MIT — see NOTICE. Changes to the saved custom theme list, as
// pure functions over what is stored. Entries this version can't read are kept as they are, so a newer app's themes
// survive an older one writing the list.
import { BUILT_IN_THEMES, RESERVED_THEME_IDS, type ThemeDefinition } from "./palettes";
import { canonicalizeThemeDefinition, parseStoredTheme } from "./themeFile";

export interface ThemeLibrary {
  /** The list as saved, unreadable entries included. */
  stored: ReadonlyArray<unknown>;
  /** The usable themes in it. */
  themes: ReadonlyArray<ThemeDefinition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasId(entry: unknown, id: string): boolean {
  return isRecord(entry) && entry.id === id;
}

function inCollection(entry: unknown, collectionId: string): boolean {
  return isRecord(entry) && isRecord(entry.collection) && entry.collection.id === collectionId;
}

export function readThemeLibrary(stored: ReadonlyArray<unknown>): ThemeLibrary {
  const themes: ThemeDefinition[] = [];
  for (const entry of stored) {
    const theme = parseStoredTheme(entry);
    if (theme && !themes.some((t) => t.id === theme.id)) themes.push(theme);
  }
  return { stored, themes };
}

/**
 * The saved list, or a throw when it is there but isn't a list: writing over it would lose whatever it holds, so the
 * caller shows the error instead.
 */
export function parseThemeLibrary(raw: string | null): ThemeLibrary {
  if (!raw) return { stored: [], themes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) throw new Error("Your saved themes couldn't be read, so nothing was changed.");
  return readThemeLibrary(parsed);
}

function assertNotReserved(theme: ThemeDefinition) {
  if (RESERVED_THEME_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`);
}

export function installTheme(library: ThemeLibrary, theme: ThemeDefinition): ThemeLibrary {
  assertNotReserved(theme);
  if (BUILT_IN_THEMES.some((t) => t.id === theme.id) || library.stored.some((entry) => hasId(entry, theme.id))) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  const canonical = canonicalizeThemeDefinition(theme);
  return { stored: [...library.stored, canonical], themes: [...library.themes, canonical] };
}

/** Replaces the installed theme with the same id in place; repeated raw entries for it collapse into one. */
export function updateTheme(library: ThemeLibrary, theme: ThemeDefinition): ThemeLibrary {
  assertNotReserved(theme);
  const index = library.themes.findIndex((t) => t.id === theme.id);
  if (index === -1) throw new Error(`The theme "${theme.label}" is not installed.`);
  const canonical = canonicalizeThemeDefinition(theme);
  const themes = [...library.themes];
  themes[index] = canonical;
  const stored: unknown[] = [];
  let replaced = false;
  for (const entry of library.stored) {
    if (!hasId(entry, theme.id)) stored.push(entry);
    else if (!replaced) {
      stored.push(canonical);
      replaced = true;
    }
  }
  return { stored, themes };
}

export function removeThemes(library: ThemeLibrary, ids: ReadonlyArray<string>): ThemeLibrary {
  const removed = new Set(ids);
  return {
    stored: library.stored.filter(
      (entry) => !isRecord(entry) || typeof entry.id !== "string" || !removed.has(entry.id),
    ),
    themes: library.themes.filter((theme) => !removed.has(theme.id)),
  };
}

export function themesInCollection(library: ThemeLibrary, collectionId: string): ReadonlyArray<ThemeDefinition> {
  return library.themes.filter((theme) => theme.collection?.id === collectionId);
}

/**
 * Swaps every theme of a collection (an Open VSX extension) for a new set, in the place the old one held, so an
 * update drops variants the extension no longer ships. `expected` guards against the list changing mid-download.
 */
export function replaceCollection(
  library: ThemeLibrary,
  collectionId: string,
  themes: ReadonlyArray<ThemeDefinition>,
  expected?: ReadonlyArray<ThemeDefinition>,
): ThemeLibrary {
  if (themes.length === 0) throw new Error("A theme collection cannot be empty.");
  const replacement = themes.map((theme) => parseStoredTheme(theme));
  if (
    replacement.some((theme) => theme === null || theme.collection?.id !== collectionId) ||
    new Set(replacement.map((theme) => theme?.id)).size !== replacement.length
  ) {
    throw new Error("That theme collection is invalid.");
  }
  const valid = replacement as ThemeDefinition[];
  if (expected && JSON.stringify(themesInCollection(library, collectionId)) !== JSON.stringify(expected)) {
    throw new Error("Your installed themes changed while this package was downloading. Try again.");
  }
  const occupied = new Set<string>(BUILT_IN_THEMES.map((theme) => theme.id));
  for (const entry of library.stored) {
    if (!inCollection(entry, collectionId) && isRecord(entry) && typeof entry.id === "string") occupied.add(entry.id);
  }
  const conflict = valid.find((theme) => RESERVED_THEME_IDS.has(theme.id) || occupied.has(theme.id));
  if (conflict) throw new Error(`A theme named "${conflict.label}" is already installed.`);

  const stored: unknown[] = [];
  let inserted = false;
  for (const entry of library.stored) {
    if (!inCollection(entry, collectionId)) stored.push(entry);
    else if (!inserted) {
      stored.push(...valid);
      inserted = true;
    }
  }
  if (!inserted) stored.push(...valid);
  return readThemeLibrary(stored);
}
