// Adapted from T3 Code (apps/web/src/components/settings/ThemeEditorPanel.tsx, ThemeColorPicker.tsx), MIT — see
// NOTICE. The theme editor's colour families and the pure parts of seeding, merging and saving a draft.
import { getStandardThemeColors, isThemeColor } from "~/theme/color";
import { createVividThemeColors } from "~/theme/derive";
import {
  getThemeColorsForAppearance,
  getThemeModes,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "~/theme/palettes";
import { parseThemeFile, THEME_FILE_VERSION, themeIdFromName } from "~/theme/themeFile";

/** Simple mode edits these two and derives the rest. */
export const THEME_EDITOR_SIMPLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

/** One colour in advanced mode: `role` is the one edited, `roles` everything that moves with it. */
export type ThemeEditorColorFamily = Readonly<{
  id: string;
  label: string;
  role: ThemeColorRole;
  roles: ReadonlyArray<ThemeColorRole>;
}>;

export const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  families: ReadonlyArray<ThemeEditorColorFamily>;
}> = [
  {
    id: "foundation",
    title: "Foundation",
    families: [
      { id: "background", label: "Background", role: "canvas", roles: ["canvas", "chrome", "toolbar"] },
      { id: "surface", label: "Surface", role: "surface", roles: ["surface"] },
      { id: "raised-surface", label: "Raised surface", role: "surfaceRaised", roles: ["surfaceRaised"] },
      { id: "overlay", label: "Overlay", role: "surfaceOverlay", roles: ["surfaceOverlay"] },
      { id: "text", label: "Text", role: "text", roles: ["text", "toolbarForeground", "toolbarControlForeground"] },
      {
        id: "muted-text",
        label: "Muted text",
        role: "mutedForeground",
        roles: ["textMuted", "mutedForeground", "placeholder", "secondaryLabel", "iconMuted", "sidebarMutedForeground"],
      },
      { id: "border", label: "Border", role: "border", roles: ["border", "toolbarBorder", "sidebarBorder"] },
      { id: "input", label: "Input", role: "input", roles: ["input"] },
    ],
  },
  {
    id: "brand-content",
    title: "Brand & content",
    families: [
      {
        id: "subtle-surface",
        label: "Subtle surface",
        role: "secondary",
        roles: ["secondary", "secondaryForeground", "muted", "toolbarControl"],
      },
      {
        id: "highlight-surface",
        label: "Highlight surface",
        role: "accentSurface",
        roles: ["accentSurface", "accentSurfaceForeground", "toolbarControlHover"],
      },
      {
        id: "accent",
        label: "Accent",
        role: "accent",
        roles: ["accent", "accentForeground", "focus", "update", "updateForeground", "updateSurface", "terminalCursor"],
      },
      {
        id: "action",
        label: "Action",
        role: "messageAction",
        roles: ["messageAction", "messageActionForeground", "messageActionHover"],
      },
      {
        id: "message-surface",
        label: "Message surface",
        role: "messageSurface",
        roles: ["messageSurface", "messageForeground"],
      },
      {
        id: "code-surface",
        label: "Code surface",
        role: "codeBackground",
        roles: ["codeBackground", "codeForeground"],
      },
    ],
  },
  {
    id: "search",
    title: "Search",
    families: [
      {
        id: "search-matches",
        label: "Search matches",
        role: "searchMatchBackground",
        roles: ["searchMatchBackground", "searchMatchForeground"],
      },
      {
        id: "current-match",
        label: "Current match",
        role: "searchMatchActiveBackground",
        roles: ["searchMatchActiveBackground", "searchMatchActiveForeground"],
      },
    ],
  },
  {
    id: "context",
    title: "Context",
    families: [
      {
        id: "sidebar-background",
        label: "Sidebar background",
        role: "sidebar",
        roles: ["sidebar", "sidebarForeground"],
      },
      {
        id: "sidebar-controls",
        label: "Sidebar controls",
        role: "sidebarControlSurface",
        roles: ["sidebarControlSurface"],
      },
      {
        id: "sidebar-selection",
        label: "Sidebar selection",
        role: "sidebarRowSelected",
        roles: ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"],
      },
      {
        id: "terminal-background",
        label: "Terminal background",
        role: "terminalBackground",
        roles: [
          "terminalBackground",
          "terminalForeground",
          "terminalSelection",
          "terminalScrollbar",
          "terminalScrollbarHover",
        ],
      },
    ],
  },
  {
    id: "status",
    title: "Status",
    families: [
      { id: "error", label: "Error", role: "error", roles: ["error", "errorForeground", "errorSurface"] },
      { id: "warning", label: "Warning", role: "warning", roles: ["warning", "warningForeground", "warningSurface"] },
    ],
  },
];

const FAMILY_BY_ROLE = new Map(
  THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families).flatMap((family) =>
    family.roles.map((role) => [role, family] as const),
  ),
);

export function getThemeEditorColorFamily(role: ThemeColorRole): ThemeEditorColorFamily | null {
  return FAMILY_BY_ROLE.get(role) ?? null;
}

const ROLE_LABELS: Partial<Record<ThemeColorRole, string>> = {
  canvas: "Background",
  toolbar: "Toolbar background",
  toolbarForeground: "Toolbar text",
  toolbarBorder: "Toolbar border",
  toolbarControl: "Toolbar control",
  toolbarControlForeground: "Toolbar control text",
  toolbarControlHover: "Toolbar control hover",
  accent: "Accent color",
  errorForeground: "Error text",
  errorSurface: "Error background",
  warningForeground: "Warning text",
  warningSurface: "Warning background",
  updateForeground: "Update text",
  updateSurface: "Update background",
};

/** A role's name for people: "textMuted" → "Text Muted", with a few renamed. */
export function getThemeRoleLabel(role: ThemeColorRole): string {
  return ROLE_LABELS[role] ?? role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

/** The advanced-mode groups whose family label, or one of whose role labels, contains the query. */
export function filterThemeEditorGroups(query: string) {
  const needle = query.trim().toLowerCase();
  return THEME_EDITOR_ROLE_GROUPS.map((group) => ({
    ...group,
    families: group.families.filter(
      (family) =>
        !needle || [family.label, ...family.roles.map(getThemeRoleLabel)].join(" ").toLowerCase().includes(needle),
    ),
  })).filter((group) => group.families.length > 0);
}

export type ThemeEditorColorsByAppearance = Record<ThemeAppearance, ThemeColors>;

/** Simple mode's palette: everything derived from the draft's background and accent (or T3 Code's, while invalid). */
export function getManagedEditorColors(appearance: ThemeAppearance, colors: ThemeColors): ThemeColors {
  const defaults = getStandardThemeColors(appearance);
  return createVividThemeColors(
    appearance,
    isThemeColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isThemeColor(colors.accent) ? colors.accent : defaults.accent,
  );
}

export interface ThemeEditorSeed {
  colors: ThemeEditorColorsByAppearance;
  appearance: ThemeAppearance;
  /**
   * Themes saved by simple mode carry `managed`; anything else (imports, hand-edited files) opens in advanced mode so
   * re-deriving can't silently throw away hand-tuned colours.
   */
  advanced: boolean;
}

/** The draft a session opens with: T3 Code's palettes, overlaid with the theme being edited or duplicated. */
export function seedThemeEditor(source: ThemeDefinition | null, initialAppearance: ThemeAppearance): ThemeEditorSeed {
  const colors: ThemeEditorColorsByAppearance = {
    light: { ...getStandardThemeColors("light") },
    dark: { ...getStandardThemeColors("dark") },
  };
  if (!source) return { colors, appearance: initialAppearance, advanced: false };
  for (const appearance of getThemeModes(source)) {
    colors[appearance] = { ...getThemeColorsForAppearance(source, appearance)! };
  }
  return {
    colors,
    appearance: getThemeColorsForAppearance(source, initialAppearance) ? initialAppearance : source.appearance,
    advanced: source.managed !== true,
  };
}

/**
 * Another custom theme with the name being typed (by id or label). Saving then adds this draft's palette to it as its
 * other appearance, which is how a light and a dark theme become one.
 */
export function findMergeTarget(
  name: string,
  customThemes: ReadonlyArray<ThemeDefinition>,
  editingId: string | null,
): ThemeDefinition | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  const id = themeIdFromName(name);
  return (
    customThemes.find(
      (theme) => theme.id !== editingId && (theme.id === id || theme.label.trim().toLowerCase() === normalized),
    ) ?? null
  );
}

/** Why an appearance can't be picked in the editor, or null when it can. */
export function appearanceLockReason(
  appearance: ThemeAppearance,
  editing: ThemeDefinition | null,
  mergeTarget: ThemeDefinition | null,
): string | null {
  if (editing && !getThemeModes(editing).includes(appearance)) {
    return `“${editing.label}” has no ${appearance} palette. Create a theme with the same name to add one.`;
  }
  if (!editing && mergeTarget && getThemeModes(mergeTarget).includes(appearance)) {
    return `“${mergeTarget.label}” already has a ${appearance} palette.`;
  }
  return null;
}

/** The merge target with more palettes added as variants, its own base kept. */
export function mergeIntoTheme(
  target: ThemeDefinition,
  palettes: Partial<Record<ThemeAppearance, ThemeColors>>,
  managed: boolean,
): ThemeDefinition {
  return {
    ...parseThemeFile({
      version: THEME_FILE_VERSION,
      id: target.id,
      name: target.label,
      appearance: target.appearance,
      colors: target.colors,
      variants: { ...target.variants, ...palettes },
      ...(target.managed === true && managed ? { managed: true } : {}),
    }),
    ...(target.collection ? { collection: target.collection } : {}),
  };
}

/** A saved theme: the edited one rewritten under the new name, or a new one from the active palette. */
export function buildEditedTheme(
  editing: ThemeDefinition,
  name: string,
  colors: ThemeEditorColorsByAppearance,
  managed: boolean,
): ThemeDefinition {
  const base = editing.appearance;
  const other: ThemeAppearance = base === "light" ? "dark" : "light";
  return {
    ...parseThemeFile({
      version: THEME_FILE_VERSION,
      id: editing.id,
      name,
      appearance: base,
      colors: colors[base],
      ...(getThemeModes(editing).length > 1 ? { variants: { [other]: colors[other] } } : {}),
      ...(managed ? { managed: true } : {}),
    }),
    ...(editing.collection ? { collection: editing.collection } : {}),
  };
}

export function buildNewTheme(
  name: string,
  appearance: ThemeAppearance,
  colors: ThemeColors,
  managed: boolean,
): ThemeDefinition {
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    name,
    appearance,
    colors,
    ...(managed ? { managed: true } : {}),
  });
}
