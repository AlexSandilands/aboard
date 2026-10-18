// The Appearance settings beyond the theme: contrast, glass, panel animations and fonts. Ranges, defaults and the
// variables they drive are T3 Code's (packages/contracts/src/settings.ts, apps/web/src/appearanceContrast.ts,
// appearanceFonts.ts, routes/__root.tsx), MIT — see NOTICE.

export const CONTRAST = { min: 50, max: 200, step: 5, default: 100 } as const;
export const GLASS_OPACITY = { min: 40, max: 100, step: 5, default: 80 } as const;
export const PANEL_ANIMATION_MS = { min: 0, max: 400, step: 25, default: 150 } as const;
export const INTERFACE_FONT_SIZE = { min: 12, max: 20, default: 16 } as const;

export const DEFAULT_SANS_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
// Concrete names first: some engines alias `ui-monospace` to the proportional system UI font.
export const DEFAULT_MONO_FONT_STACK = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export interface AppearancePrefs {
  contrast: number;
  glassOpacity: number;
  panelAnimationMs: number;
  /** A font family list as typed; empty is the default stack. */
  fontSans: string;
  fontMono: string;
  fontSize: number;
}

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  contrast: CONTRAST.default,
  glassOpacity: GLASS_OPACITY.default,
  panelAnimationMs: PANEL_ANIMATION_MS.default,
  fontSans: "",
  fontMono: "",
  fontSize: INTERFACE_FONT_SIZE.default,
};

/** Rounds to the slider's step and keeps it in range; anything not a number falls back to the default. */
export function clampSetting(
  value: unknown,
  range: { min: number; max: number; default: number; step?: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return range.default;
  const step = range.step ?? 1;
  const stepped = Math.round((value - range.min) / step) * step + range.min;
  return Math.min(range.max, Math.max(range.min, stepped));
}

/** Re-validates stored prefs, so a hand-edited or older save can't put the page in a broken state. */
export function normalizeAppearancePrefs(value: Partial<Record<keyof AppearancePrefs, unknown>>): AppearancePrefs {
  return {
    contrast: clampSetting(value.contrast, CONTRAST),
    glassOpacity: clampSetting(value.glassOpacity, GLASS_OPACITY),
    panelAnimationMs: clampSetting(value.panelAnimationMs, PANEL_ANIMATION_MS),
    fontSans: typeof value.fontSans === "string" ? value.fontSans.slice(0, 200) : "",
    fontMono: typeof value.fontMono === "string" ? value.fontMono.slice(0, 200) : "",
    fontSize: clampSetting(value.fontSize, INTERFACE_FONT_SIZE),
  };
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare) && !/[;{}\\]/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replace(/["\\;{}]/g, "")}"`;
}

/** A typed font list as CSS: names quoted where they need it, empty entries dropped. Null when nothing is left. */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0 && name !== '""');
  return families.length > 0 ? families.join(", ") : null;
}

/**
 * What the prefs put on `<html>`: inline style properties and data attributes. The boot script in index.html applies
 * the same object from storage before first paint. A property left out is one the stylesheet's default covers.
 */
export interface AppearancePaint {
  style: Record<string, string>;
  data: Record<string, string>;
}

export function appearancePaint(prefs: AppearancePrefs, reducedMotion: boolean): AppearancePaint {
  const style: Record<string, string> = {};
  const { contrast } = prefs;
  if (contrast !== CONTRAST.default) {
    style["--appearance-contrast-base"] = `${Math.min(contrast, 100)}%`;
    style["--appearance-contrast-boost"] = `${Math.max(contrast - 100, 0)}%`;
    style["--appearance-contrast-border-boost"] = `${Math.max(contrast - 100, 0) / 4}%`;
  }
  if (prefs.glassOpacity !== GLASS_OPACITY.default) style["--glass-opacity"] = `${prefs.glassOpacity}%`;
  // Fully opaque glass has nothing to blur, and the blur still costs a compositing layer.
  if (prefs.glassOpacity === 100) style["--glass-blur"] = "0px";
  const sans = cssFontFamilies(prefs.fontSans);
  if (sans) style["--font-sans"] = `${sans}, ${DEFAULT_SANS_FONT_STACK}`;
  const mono = cssFontFamilies(prefs.fontMono);
  if (mono) style["--font-mono"] = `${mono}, ${DEFAULT_MONO_FONT_STACK}`;
  // The interface size is the root font size, so every rem-based dimension scales with it (as in T3 Code).
  if (prefs.fontSize !== INTERFACE_FONT_SIZE.default) style["font-size"] = `${prefs.fontSize}px`;
  style["--panel-animation-duration"] = `${prefs.panelAnimationMs}ms`;
  const animate = prefs.panelAnimationMs > 0 && !reducedMotion;
  return { style, data: { "panel-animations": animate ? "true" : "false" } };
}

/** The style properties appearancePaint can set, so the runtime clears the ones a new paint leaves out. */
export const APPEARANCE_STYLE_PROPERTIES = [
  "--appearance-contrast-base",
  "--appearance-contrast-boost",
  "--appearance-contrast-border-boost",
  "--glass-opacity",
  "--glass-blur",
  "--font-sans",
  "--font-mono",
  "font-size",
  "--panel-animation-duration",
] as const;
