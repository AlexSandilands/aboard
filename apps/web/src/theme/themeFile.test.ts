import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, T3_CODE_DARK_THEME_COLORS, T3_CODE_LIGHT_THEME_COLORS, THEME_COLOR_ROLES } from "./palettes";
import { isThemeColor, parseStoredThemes, parseThemeFile, serializeThemeFile, themeIdFromName } from "./themeFile";

const file = (over: Record<string, unknown> = {}) => ({
  version: 1,
  id: "dusk",
  name: "Dusk",
  appearance: "dark",
  colors: { canvas: "oklch(0.2 0.02 300)", accent: "#8b5cf6" },
  ...over,
});

describe("the palettes", () => {
  it("give every built-in and its variant all 61 roles", () => {
    expect(THEME_COLOR_ROLES).toHaveLength(61);
    for (const theme of BUILT_IN_THEMES) {
      expect(Object.keys(theme.colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
      expect(Object.keys(theme.variants?.dark ?? {}).sort()).toEqual([...THEME_COLOR_ROLES].sort());
    }
  });

  it("hold only literal colours", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const value of [...Object.values(theme.colors), ...Object.values(theme.variants?.dark ?? {})]) {
        expect(isThemeColor(value)).toBe(true);
      }
    }
  });
});

describe("isThemeColor", () => {
  it("accepts hex and colour functions", () => {
    for (const value of ["#fff", "#ffff", "#0a0a0a", "#0a0a0a80", "oklch(0.5 0.1 200)", "rgb(1 2 3 / 50%)"]) {
      expect(isThemeColor(value)).toBe(true);
    }
  });

  it("refuses anything that could escape a custom property", () => {
    for (const value of ["var(--x)", "red; color: blue", "rgb(calc(1) 2 3)", "#12345", "red", "", 4]) {
      expect(isThemeColor(value)).toBe(false);
    }
  });
});

describe("parseThemeFile", () => {
  it("fills missing roles from T3 Code's colours for the appearance", () => {
    const theme = parseThemeFile(file());
    expect(theme).toMatchObject({ id: "dusk", label: "Dusk", appearance: "dark" });
    expect(theme.colors.canvas).toBe("oklch(0.2 0.02 300)");
    expect(theme.colors.text).toBe(T3_CODE_DARK_THEME_COLORS.text);
  });

  it("parses a variant against its own appearance's defaults", () => {
    const theme = parseThemeFile(file({ variants: { light: { canvas: "#ffffff" } } }));
    expect(theme.variants?.light?.canvas).toBe("#ffffff");
    expect(theme.variants?.light?.text).toBe(T3_CODE_LIGHT_THEME_COLORS.text);
  });

  it("derives the id from the name when there is none", () => {
    expect(parseThemeFile(file({ id: undefined, name: "  Late Night!! " })).id).toBe("late-night");
    expect(themeIdFromName("!!!")).toBe("custom-theme");
  });

  it("round-trips a built-in through serializeThemeFile", () => {
    for (const theme of BUILT_IN_THEMES) {
      const copy = { ...theme, id: `${theme.id}-copy` };
      const parsed = parseThemeFile(JSON.parse(serializeThemeFile(copy)));
      expect(parsed.colors).toEqual(theme.colors);
      expect(parsed.variants).toEqual(theme.variants);
    }
  });

  it.each([
    ["a non-object", "nope", /JSON object/],
    ["another version", file({ version: 2 }), /unsupported version/],
    ["no name", file({ name: " " }), /need a name/],
    ["a bad appearance", file({ appearance: "dim" }), /appearance/],
    ["an unknown role", file({ colors: { glow: "#fff" } }), /not a supported theme color role/],
    ["a non-literal colour", file({ colors: { canvas: "var(--x)" } }), /literal CSS color/],
    ["no colours", file({ colors: {} }), /at least one color/],
    ["a reserved id", file({ id: "grove" }), /reserved/],
    ["a bad id", file({ id: "Bad Id" }), /lowercase/],
    ["a repeated base variant", file({ variants: { dark: { canvas: "#000000" } } }), /must not repeat/],
    ["a bad variant name", file({ variants: { dim: { canvas: "#000000" } } }), /only be named/],
    ["a bad collection", file({ collection: { id: "", label: "x" } }), /collections/],
  ])("refuses %s", (_name, value, message) => {
    expect(() => parseThemeFile(value)).toThrow(message);
  });
});

describe("parseStoredThemes", () => {
  it("keeps usable themes leniently and drops the rest", () => {
    const raw = JSON.stringify([
      { id: "dusk", label: "Dusk", appearance: "dark", colors: { canvas: "#111111", text: "var(--x)", glow: "#fff" } },
      { id: "dusk", label: "Again", appearance: "dark", colors: {} },
      { id: "grove", label: "Shadow", appearance: "light", colors: {} },
      { id: "nope", label: "", appearance: "light", colors: {} },
      "junk",
    ]);
    const themes = parseStoredThemes(raw);
    expect(themes.map((t) => t.id)).toEqual(["dusk"]);
    expect(themes[0]!.colors.canvas).toBe("#111111");
    expect(themes[0]!.colors.text).toBe(T3_CODE_DARK_THEME_COLORS.text);
  });

  it("returns nothing for missing or malformed storage", () => {
    expect(parseStoredThemes(null)).toEqual([]);
    expect(parseStoredThemes("{")).toEqual([]);
    expect(parseStoredThemes("{}")).toEqual([]);
  });
});
