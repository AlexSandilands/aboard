// Adapted from T3 Code (apps/web/src/themePalette.ts), MIT — see NOTICE. Reads and writes T3 Code's theme file
// format, so a theme exported from T3 Code imports into the board unchanged and the other way round. Every colour is
// saved in canonical `oklch(L C H)` form, as T3 Code saves it.
import { z } from "zod";
import { decodeThemeColors, toCanonicalThemeColor } from "./color";
import {
  RESERVED_THEME_IDS,
  T3_CHAT_THEME,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "./palettes";

export const THEME_FILE_VERSION = 1;

const ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

const themeId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,47})$/);
const themeLabel = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(48));
const appearance = z.enum(["light", "dark"]);
const collection = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9.:-]{0,127}$/i), label: themeLabel });

/** The shape of a T3 Code theme file; the roles and colours are checked by parseThemeFile. */
export const ThemeFileSchema = z.object({
  version: z.literal(THEME_FILE_VERSION),
  id: z.string().optional(),
  name: z.string(),
  appearance,
  colors: z.record(z.string(), z.unknown()),
  variants: z.record(z.string(), z.unknown()).optional(),
  collection: z.unknown().optional(),
  managed: z.boolean().optional(),
});

export type ThemeFile = {
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: Partial<Record<ThemeColorRole, string>>;
  variants?: Partial<Record<ThemeAppearance, Partial<Record<ThemeColorRole, string>>>>;
  collection?: { id: string; label: string };
  managed?: boolean;
};

/**
 * What a theme file leaves out falls back to. T3 Code fills gaps from T3 Chat's palette, not its own default one, so a
 * partial file looks the same in both apps.
 */
export function getDefaultThemeColors(mode: ThemeAppearance): ThemeColors {
  return mode === "dark" ? T3_CHAT_THEME.variants!.dark! : T3_CHAT_THEME.colors;
}

export function themeIdFromName(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return id || "custom-theme";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseColorOverrides(value: unknown): Partial<Record<ThemeColorRole, string>> {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!ROLE_SET.has(role)) throw new Error(`"${role}" is not a supported theme color role.`);
    const normalized = toCanonicalThemeColor(color);
    if (!normalized) {
      throw new Error(`The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`);
    }
    overrides[role as ThemeColorRole] = normalized;
  }
  if (Object.keys(overrides).length === 0) throw new Error("Add at least one color role to the theme file.");
  return overrides;
}

/** Parses a theme file (already JSON-decoded). Throws an Error whose message can be shown to the user. */
export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }
  const file = ThemeFileSchema.safeParse(value);
  if (!file.success) {
    const issue = file.error.issues[0];
    const field = issue?.path[0];
    if (field === "name") throw new Error("Theme files need a name (48 characters or fewer).");
    if (field === "appearance") throw new Error('Theme files need an appearance of "light" or "dark".');
    if (field === "colors") throw new Error("Theme files need a colors object.");
    if (field === "variants") throw new Error("Theme variants must be an object.");
    throw new Error("This isn't a theme file.");
  }
  const { data } = file;
  const label = themeLabel.safeParse(data.name);
  if (!label.success) throw new Error("Theme files need a name (48 characters or fewer).");

  const id = data.id ?? themeIdFromName(label.data);
  if (!themeId.safeParse(id).success) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);

  const colors = { ...getDefaultThemeColors(data.appearance), ...parseColorOverrides(data.colors) };
  const parsedCollection = data.collection === undefined ? undefined : collection.safeParse(data.collection);
  if (parsedCollection && !parsedCollection.success) throw new Error("Theme collections need a valid id and label.");

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const [mode, variantColors] of Object.entries(data.variants ?? {})) {
    if (mode !== "light" && mode !== "dark") throw new Error('Theme variants may only be named "light" or "dark".');
    if (mode === data.appearance) {
      throw new Error(`Theme variants must not repeat the base appearance "${data.appearance}".`);
    }
    variants[mode] = { ...getDefaultThemeColors(mode), ...parseColorOverrides(variantColors) };
  }

  return {
    id,
    label: label.data,
    appearance: data.appearance,
    colors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(parsedCollection?.success ? { collection: parsedCollection.data } : {}),
    ...(data.managed === true ? { managed: true } : {}),
  };
}

/** The theme with every colour in canonical form; throws when one isn't a colour. */
export function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
  return {
    ...theme,
    colors: decodeThemeColors(theme.colors),
    ...(theme.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(theme.variants).map(([mode, colors]) => [mode, decodeThemeColors(colors)]),
          ),
        }
      : {}),
  };
}

export function serializeThemeFile(source: ThemeDefinition): string {
  const theme = canonicalizeThemeDefinition(source);
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
    ...(theme.collection ? { collection: theme.collection } : {}),
    ...(theme.managed ? { managed: true } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Keeps the roles that are known and hold a colour; a stored theme shouldn't fail over one bad value. */
function lenientColors(value: unknown, mode: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;
  const colors: Record<string, string> = { ...getDefaultThemeColors(mode) };
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color);
    if (ROLE_SET.has(role) && normalized) colors[role] = normalized;
  }
  return colors as ThemeColors;
}

/** Reads one saved custom theme leniently, or null when it isn't usable at all. */
export function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  const id = themeId.safeParse(value.id);
  const label = themeLabel.safeParse(value.label);
  const mode = appearance.safeParse(value.appearance);
  if (!id.success || RESERVED_THEME_IDS.has(id.data) || !label.success || !mode.success) return null;
  const colors = lenientColors(value.colors, mode.data);
  if (!colors) return null;

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) return null;
    for (const [variantMode, variantColors] of Object.entries(value.variants)) {
      if (variantMode !== "light" && variantMode !== "dark") return null;
      // A variant repeating the base appearance would be shadowed by the base colours.
      if (variantMode === mode.data) continue;
      const parsed = lenientColors(variantColors, variantMode);
      if (!parsed) return null;
      variants[variantMode] = parsed;
    }
  }
  const parsedCollection = collection.safeParse(value.collection);
  return {
    id: id.data,
    label: label.data,
    appearance: mode.data,
    colors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(parsedCollection.success ? { collection: parsedCollection.data } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

/** Reads the saved custom theme list, skipping unusable entries and repeated ids. */
export function parseStoredThemes(raw: string | null): ThemeDefinition[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const themes: ThemeDefinition[] = [];
  for (const value of parsed) {
    const theme = parseStoredTheme(value);
    if (theme && !themes.some((t) => t.id === theme.id)) themes.push(theme);
  }
  return themes;
}
