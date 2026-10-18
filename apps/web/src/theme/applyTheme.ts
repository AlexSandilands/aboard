// Adapted from T3 Code (apps/web/src/themePalette.ts applyThemePalette), MIT — see NOTICE.
import { isThemeColor } from "./color";
import { APP_THEME_VARIABLES, type ThemeAppearance, type ThemeColorRole, type ThemeColors } from "./palettes";
import type { ActiveTheme } from "./themeState.logic";

/** The board's own `--background` per appearance: what the default T3 Code theme paints. */
export const DEFAULT_BACKGROUND: Record<ThemeAppearance, string> = { light: "#fcfcfc", dark: "#0a0a0a" };

/**
 * Writes a theme's colours to `<html>` as `--app-theme-*` variables and marks it with `data-theme-id`, which switches
 * on the mapping block in index.css. Null (the default theme) clears both, so the board's own tokens apply.
 */
export function applyThemePalette(root: HTMLElement, active: ActiveTheme | null): void {
  if (active) {
    root.dataset.themeId = active.theme.id;
    for (const [role, value] of Object.entries(active.colors) as Array<[ThemeColorRole, string]>) {
      root.style.setProperty(APP_THEME_VARIABLES[role], value);
    }
    return;
  }
  delete root.dataset.themeId;
  for (const variable of Object.values(APP_THEME_VARIABLES)) root.style.removeProperty(variable);
}

/** The `data-theme-id` of the theme editor's draft; switches on the same mapping block as a saved theme. */
export const THEME_PREVIEW_ID = "__preview";

/**
 * Paints a palette that isn't saved (the theme editor's draft). Values still being typed aren't colours yet and are
 * skipped, leaving the role's last good value.
 */
export function applyThemePreview(root: HTMLElement, colors: ThemeColors, appearance: ThemeAppearance): void {
  root.dataset.themeId = THEME_PREVIEW_ID;
  root.classList.toggle("dark", appearance === "dark");
  root.style.colorScheme = appearance;
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    if (isThemeColor(value)) root.style.setProperty(APP_THEME_VARIABLES[role], value);
  }
  if (isThemeColor(colors.canvas)) root.style.backgroundColor = colors.canvas;
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * Any CSS colour as `#rrggbb`, for the desktop shell: Electron's setBackgroundColor doesn't take oklch. The canvas
 * does the conversion. Null when there's no canvas or the value isn't a colour.
 */
export function toHexColor(color: string): string | null {
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  try {
    if (probe === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      probe = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}
