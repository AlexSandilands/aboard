import { describe, expect, it } from "vitest";
import { applyThemePalette } from "./applyTheme";
import { GROVE_THEME, OCEAN_THEME, T3_CODE_LIGHT_THEME_COLORS, type ThemeDefinition } from "./palettes";
import {
  buildPaintSnapshot,
  parseThemeHalves,
  parseThemeId,
  resolveActiveTheme,
  resolveDesktopTheme,
  resolveThemeAppearance,
  selectThemeHalf,
  selectWholeTheme,
  themeOwners,
  type ThemeSelection,
} from "./themeState.logic";

const LIGHT_ONLY: ThemeDefinition = {
  id: "paper",
  label: "Paper",
  appearance: "light",
  colors: T3_CODE_LIGHT_THEME_COLORS,
};
const custom = [LIGHT_ONLY];

const selection = (over: Partial<ThemeSelection> = {}): ThemeSelection => ({
  mode: "dark",
  themeId: null,
  halves: {},
  ...over,
});

describe("parsing saved choices", () => {
  it("drops ids that name no theme", () => {
    expect(parseThemeId("grove", custom)).toBe("grove");
    expect(parseThemeId("paper", custom)).toBe("paper");
    expect(parseThemeId("gone", custom)).toBeNull();
    expect(parseThemeId(null, custom)).toBeNull();
  });

  it("keeps only halves whose theme covers that appearance", () => {
    expect(parseThemeHalves(JSON.stringify({ light: "grove", dark: "ocean" }), custom)).toEqual({
      light: "grove",
      dark: "ocean",
    });
    expect(parseThemeHalves(JSON.stringify({ light: "paper", dark: "paper" }), custom)).toEqual({ light: "paper" });
    expect(parseThemeHalves("not json", custom)).toEqual({});
    expect(parseThemeHalves(JSON.stringify(["grove"]), custom)).toEqual({});
  });
});

describe("resolveThemeAppearance", () => {
  it("follows the mode, and the system for system", () => {
    expect(resolveThemeAppearance(selection({ mode: "light" }), true, custom)).toBe("light");
    expect(resolveThemeAppearance(selection({ mode: "system" }), true, custom)).toBe("dark");
    expect(resolveThemeAppearance(selection({ mode: "system" }), false, custom)).toBe("light");
  });

  it("forces a single-appearance base theme's own appearance", () => {
    expect(resolveThemeAppearance(selection({ mode: "dark", themeId: "paper" }), false, custom)).toBe("light");
  });

  it("lets a half cover the appearance the base theme lacks", () => {
    const s = selection({ mode: "dark", themeId: "paper", halves: { dark: "ocean" } });
    expect(resolveThemeAppearance(s, false, custom)).toBe("dark");
    expect(resolveActiveTheme(s, "dark", custom)?.theme.id).toBe("ocean");
  });
});

describe("resolveActiveTheme", () => {
  it("is null for the default T3 Code theme", () => {
    expect(resolveActiveTheme(selection(), "dark", custom)).toBeNull();
  });

  it("uses the base theme's colours for the appearance", () => {
    const active = resolveActiveTheme(selection({ themeId: "grove" }), "dark", custom);
    expect(active?.colors).toBe(GROVE_THEME.variants?.dark);
    expect(resolveActiveTheme(selection({ themeId: "grove" }), "light", custom)?.colors).toBe(GROVE_THEME.colors);
  });

  it("prefers the half over the base", () => {
    const s = selection({ themeId: "grove", halves: { light: "ocean" } });
    expect(resolveActiveTheme(s, "light", custom)?.colors).toBe(OCEAN_THEME.colors);
    expect(resolveActiveTheme(s, "dark", custom)?.theme.id).toBe("grove");
  });
});

describe("resolveDesktopTheme", () => {
  it("passes the mode through when both appearances are covered", () => {
    expect(resolveDesktopTheme(selection({ mode: "system", themeId: "grove" }), custom)).toBe("system");
    expect(resolveDesktopTheme(selection({ mode: "light" }), custom)).toBe("light");
  });

  it("pins a single-appearance theme's appearance", () => {
    expect(resolveDesktopTheme(selection({ mode: "system", themeId: "paper" }), custom)).toBe("light");
    expect(resolveDesktopTheme(selection({ mode: "dark", themeId: "paper" }), custom)).toBe("light");
  });
});

describe("selecting themes", () => {
  it("clicking a card takes both appearances and clears the halves", () => {
    const next = selectWholeTheme(selection({ halves: { light: "ocean" } }), "grove", custom);
    expect(next).toMatchObject({ themeId: "grove", halves: {} });
    expect(themeOwners(next, custom)).toEqual({ light: "grove", dark: "grove" });
  });

  it("clicking T3 Code's card resets to the default", () => {
    expect(selectWholeTheme(selection({ themeId: "grove", halves: { dark: "iris" } }), null, custom)).toMatchObject({
      themeId: null,
      halves: {},
    });
  });

  it("a single-appearance theme's card takes only its half", () => {
    const next = selectWholeTheme(selection({ themeId: "grove" }), "paper", custom);
    expect(themeOwners(next, custom)).toEqual({ light: "paper", dark: "grove" });
  });

  it("clicking an orb sets only that half", () => {
    const next = selectThemeHalf(selection({ themeId: "grove" }), "dark", "iris", custom);
    expect(themeOwners(next, custom)).toEqual({ light: "grove", dark: "iris" });
  });

  it("T3 Code's orb over a themed base keeps the other half", () => {
    const next = selectThemeHalf(selection({ themeId: "grove" }), "light", null, custom);
    expect(next).toMatchObject({ themeId: null, halves: { dark: "grove" } });
    expect(themeOwners(next, custom)).toEqual({ light: null, dark: "grove" });
  });

  it("T3 Code's orb without a base clears the half", () => {
    const next = selectThemeHalf(selection({ halves: { light: "ocean", dark: "iris" } }), "light", null, custom);
    expect(themeOwners(next, custom)).toEqual({ light: null, dark: "iris" });
  });

  it("keeps the mode", () => {
    expect(selectWholeTheme(selection({ mode: "system" }), "grove", custom).mode).toBe("system");
  });
});

describe("buildPaintSnapshot", () => {
  it("names each variable and the canvas per appearance", () => {
    const snapshot = buildPaintSnapshot(selection({ halves: { dark: "grove" } }), custom);
    expect(snapshot.light).toEqual({ appearance: "light", id: null, background: null, vars: null });
    expect(snapshot.dark.id).toBe("grove");
    expect(snapshot.dark.background).toBe(GROVE_THEME.variants?.dark?.canvas);
    expect(snapshot.dark.vars?.["--app-theme-canvas"]).toBe(GROVE_THEME.variants?.dark?.canvas);
    expect(snapshot.dark.vars?.["--app-theme-terminal-selection-background"]).toBe(
      GROVE_THEME.variants?.dark?.terminalSelection,
    );
  });

  it("records the forced appearance of a single-appearance theme", () => {
    expect(buildPaintSnapshot(selection({ themeId: "paper" }), custom).dark).toMatchObject({
      appearance: "light",
      id: "paper",
    });
  });
});

describe("applyThemePalette", () => {
  function fakeRoot() {
    const props = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (name: string, value: string) => props.set(name, value),
        removeProperty: (name: string) => props.delete(name),
      },
    };
    return { root: root as unknown as HTMLElement, props, dataset: root.dataset };
  }

  it("sets the theme id and a variable per role, then clears them", () => {
    const { root, props, dataset } = fakeRoot();
    const active = resolveActiveTheme(selection({ themeId: "ocean" }), "light", custom);
    applyThemePalette(root, active);
    expect(dataset.themeId).toBe("ocean");
    expect(props.get("--app-theme-accent")).toBe(OCEAN_THEME.colors.accent);
    expect(props.size).toBe(Object.keys(OCEAN_THEME.colors).length);

    applyThemePalette(root, null);
    expect(dataset.themeId).toBeUndefined();
    expect(props.size).toBe(0);
  });
});
