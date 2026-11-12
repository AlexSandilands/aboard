import { describe, expect, it } from "vitest";
import { BRAND } from "@repo/contracts";
import { isThemeColor, parseThemeRgbColor, themeContrastRatio } from "./color";
import { BRIDGE_THEME, FIREFLY_THEME, TIDE_THEME } from "./aboardPalettes";
import {
  BOARD_THEMES,
  BUILT_IN_THEMES,
  getThemeColorsForAppearance,
  RESERVED_THEME_IDS,
  THEME_COLOR_ROLES,
  type ThemeColorRole,
  type ThemeColors,
} from "./palettes";

function contrast(colors: ThemeColors, foreground: ThemeColorRole, background: ThemeColorRole): number {
  const rgb = (role: ThemeColorRole) => parseThemeRgbColor(colors[role], { r: 0, g: 0, b: 0 });
  return themeContrastRatio(rgb(foreground), rgb(background));
}

// What each pair must reach: body text 7:1 on the canvas (as createVividThemeColors solves it), everything else 4.5:1.
const PAIRS: ReadonlyArray<[ThemeColorRole, ThemeColorRole, number]> = [
  ["text", "canvas", 7],
  ["text", "surface", 7],
  ["textMuted", "canvas", 4.5],
  ["mutedForeground", "muted", 4.5],
  ["placeholder", "surfaceRaised", 4.5],
  ["messageActionForeground", "messageAction", 4.5],
  ["accentSurfaceForeground", "accentSurface", 4.5],
  ["secondaryForeground", "secondary", 4.5],
  ["messageForeground", "messageSurface", 4.5],
  ["updateForeground", "updateSurface", 4.5],
  ["errorForeground", "errorSurface", 4.5],
  ["warningForeground", "warningSurface", 4.5],
  ["sidebarForeground", "sidebar", 7],
  ["sidebarMutedForeground", "sidebar", 4.5],
  ["searchMatchForeground", "searchMatchBackground", 4.5],
  ["searchMatchActiveForeground", "searchMatchActiveBackground", 4.5],
];

describe("the board's own themes", () => {
  it("come first among the built-ins, in card order", () => {
    expect(BOARD_THEMES).toEqual([BRIDGE_THEME, FIREFLY_THEME, TIDE_THEME]);
    expect(BUILT_IN_THEMES.slice(0, 3)).toEqual(BOARD_THEMES);
    expect(BUILT_IN_THEMES.some((theme) => theme.id === "t3-chat")).toBe(false);
  });

  it("show the default under the product's name, with neutral ids", () => {
    expect(BRIDGE_THEME.label).toBe(BRAND.name);
    for (const theme of BOARD_THEMES) {
      expect(theme.id).not.toContain(BRAND.id);
      expect(RESERVED_THEME_IDS.has(theme.id)).toBe(true);
    }
    expect(RESERVED_THEME_IDS.has("t3-code")).toBe(true);
    expect(RESERVED_THEME_IDS.has("t3-chat")).toBe(true);
  });

  describe.each(BOARD_THEMES.map((theme) => [theme.id, theme] as const))("%s", (_id, theme) => {
    it.each(["light", "dark"] as const)("has every role as a literal colour in %s", (appearance) => {
      const colors = getThemeColorsForAppearance(theme, appearance);
      expect(colors).not.toBeNull();
      expect(Object.keys(colors!).toSorted()).toEqual([...THEME_COLOR_ROLES].toSorted());
      for (const value of Object.values(colors!)) expect(isThemeColor(value)).toBe(true);
    });

    it.each(["light", "dark"] as const)("keeps its text readable in %s", (appearance) => {
      const colors = getThemeColorsForAppearance(theme, appearance)!;
      for (const [foreground, background, minimum] of PAIRS) {
        expect({ pair: `${foreground} on ${background}`, ratio: contrast(colors, foreground, background) }).toEqual({
          pair: `${foreground} on ${background}`,
          ratio: expect.toSatisfy((ratio: number) => ratio >= minimum),
        });
      }
    });
  });
});
