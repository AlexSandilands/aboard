import { describe, expect, it } from "vitest";
import { decodeThemeColors, isThemeColor, toCanonicalThemeColor } from "./color";
import { BUILT_IN_THEMES, T3_CHAT_THEME, THEME_COLOR_ROLES } from "./palettes";
import { parseStoredThemes, parseThemeFile, serializeThemeFile, themeIdFromName } from "./themeFile";

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
  it("accepts hex, colour functions and named colours", () => {
    for (const value of ["#fff", "#ffff", "#0a0a0a", "#0a0a0a80", "oklch(0.5 0.1 200)", "rgb(1 2 3 / 50%)", "red"]) {
      expect(isThemeColor(value)).toBe(true);
    }
  });

  it("refuses anything that could escape a custom property", () => {
    for (const value of ["var(--x)", "red; color: blue", "rgb(calc(1) 2 3)", "#12345", "", 4]) {
      expect(isThemeColor(value)).toBe(false);
    }
  });
});

describe("parseThemeFile", () => {
  it("fills missing roles from T3 Chat's colours for the appearance, as T3 Code does", () => {
    const theme = parseThemeFile(file());
    expect(theme).toMatchObject({ id: "dusk", label: "Dusk", appearance: "dark" });
    expect(theme.colors.canvas).toBe("oklch(0.2 0.02 300)");
    expect(theme.colors.accent).toBe(toCanonicalThemeColor("#8b5cf6"));
    expect(theme.colors.text).toBe(T3_CHAT_THEME.variants!.dark!.text);
  });

  it("parses a variant against its own appearance's defaults", () => {
    const theme = parseThemeFile(file({ variants: { light: { canvas: "#ffffff" } } }));
    expect(theme.variants?.light?.canvas).toBe("oklch(1 0 0)");
    expect(theme.variants?.light?.text).toBe(T3_CHAT_THEME.colors.text);
  });

  it("saves every CSS colour form as oklch, keeping alpha", () => {
    const theme = parseThemeFile(
      file({
        colors: {
          canvas: "oklch(62% 0.2 280deg / 50%)",
          focus: "rgb(10 20 30 / 50%)",
          error: "hsl(350 80% 50%)",
          terminalSelection: "rebeccapurple",
          terminalScrollbar: "transparent",
        },
      }),
    );
    expect(theme.colors.canvas).toBe("oklch(0.62 0.2 280 / 0.5)");
    expect(theme.colors.terminalScrollbar).toBe("oklch(0 0 0 / 0)");
    for (const role of ["focus", "error", "terminalSelection"] as const) expect(theme.colors[role]).toMatch(/^oklch\(/);
  });

  it("derives the id from the name when there is none", () => {
    expect(parseThemeFile(file({ id: undefined, name: "  Late Night!! " })).id).toBe("late-night");
    expect(themeIdFromName("!!!")).toBe("custom-theme");
  });

  it("round-trips a built-in through serializeThemeFile", () => {
    for (const theme of BUILT_IN_THEMES) {
      const copy = { ...theme, id: `${theme.id}-copy` };
      const parsed = parseThemeFile(JSON.parse(serializeThemeFile(copy)));
      expect(parsed.colors).toEqual(decodeThemeColors(theme.colors));
      expect(parsed.variants?.dark).toEqual(decodeThemeColors(theme.variants!.dark!));
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
    expect(themes[0]!.colors.canvas).toBe(toCanonicalThemeColor("#111111"));
    expect(themes[0]!.colors.text).toBe(T3_CHAT_THEME.variants!.dark!.text);
  });

  it("returns nothing for missing or malformed storage", () => {
    expect(parseStoredThemes(null)).toEqual([]);
    expect(parseStoredThemes("{")).toEqual([]);
    expect(parseStoredThemes("{}")).toEqual([]);
  });
});
