import { describe, expect, it } from "vitest";
import { toCanonicalThemeColor } from "./color";
import type { ThemeDefinition } from "./palettes";
import { parseThemeFile } from "./themeFile";
import {
  installTheme,
  parseThemeLibrary,
  readThemeLibrary,
  removeThemes,
  replaceCollection,
  themesInCollection,
  updateTheme,
} from "./themeLibrary.logic";

const theme = (name: string, extra: Record<string, unknown> = {}): ThemeDefinition =>
  parseThemeFile({ version: 1, name, appearance: "dark", colors: { canvas: "#101018" }, ...extra });
const inCollection = (t: ThemeDefinition, id = "open-vsx:demo.theme"): ThemeDefinition => ({
  ...t,
  collection: { id, label: "Demo" },
});

describe("parseThemeLibrary", () => {
  it("is empty when nothing is saved", () => {
    expect(parseThemeLibrary(null)).toEqual({ stored: [], themes: [] });
  });

  it("refuses to work on a saved value that isn't a list, so writing can't destroy it", () => {
    expect(() => parseThemeLibrary("{")).toThrow(/couldn't be read/);
    expect(() => parseThemeLibrary('{"a":1}')).toThrow(/couldn't be read/);
  });
});

describe("installTheme", () => {
  it("saves the theme in canonical colours", () => {
    const next = installTheme(readThemeLibrary([]), {
      ...theme("Dusk"),
      colors: { ...theme("Dusk").colors, text: "#fff" },
    });
    expect(next.themes.map((t) => t.id)).toEqual(["dusk"]);
    expect(next.themes[0]!.colors.text).toBe(toCanonicalThemeColor("#fff"));
  });

  it("refuses a taken, built-in or reserved id", () => {
    const library = installTheme(readThemeLibrary([]), theme("Dusk"));
    expect(() => installTheme(library, theme("Dusk"))).toThrow(/already installed/);
    expect(() => installTheme(library, { ...theme("Grove x"), id: "grove" })).toThrow(/reserved/);
  });

  it("keeps entries it can't read", () => {
    const next = installTheme(readThemeLibrary([{ id: "future", shape: "v2" }]), theme("Dusk"));
    expect(next.stored).toHaveLength(2);
    expect(next.stored[0]).toEqual({ id: "future", shape: "v2" });
  });
});

describe("updateTheme", () => {
  it("replaces the theme in place and collapses repeated raw entries", () => {
    const first = theme("Dusk");
    const library = readThemeLibrary([theme("Alpha"), first, { ...first, label: "Dusk again" }]);
    const next = updateTheme(library, { ...first, label: "Dusk 2" });
    expect(next.stored.map((entry) => (entry as ThemeDefinition).label)).toEqual(["Alpha", "Dusk 2"]);
  });

  it("refuses a theme that isn't installed", () => {
    expect(() => updateTheme(readThemeLibrary([]), theme("Dusk"))).toThrow(/not installed/);
  });
});

describe("removeThemes", () => {
  it("drops every entry with those ids", () => {
    const library = readThemeLibrary([theme("Alpha"), theme("Beta"), "junk"]);
    expect(removeThemes(library, ["alpha"]).stored).toEqual([library.stored[1], "junk"]);
  });
});

describe("replaceCollection", () => {
  const a = inCollection(theme("Demo Light"));
  const b = inCollection(theme("Demo Dark"));

  it("swaps a collection's themes in the place it held, dropping variants that are gone", () => {
    const library = readThemeLibrary([theme("Alpha"), a, b, theme("Omega")]);
    const c = inCollection(theme("Demo Soft"));
    const next = replaceCollection(
      library,
      "open-vsx:demo.theme",
      [b, c],
      themesInCollection(library, "open-vsx:demo.theme"),
    );
    expect(next.themes.map((t) => t.id)).toEqual(["alpha", "demo-dark", "demo-soft", "omega"]);
  });

  it("appends a collection that isn't installed yet", () => {
    const next = replaceCollection(readThemeLibrary([theme("Alpha")]), "open-vsx:demo.theme", [a]);
    expect(next.themes.map((t) => t.id)).toEqual(["alpha", "demo-light"]);
  });

  it("refuses when the installed collection changed during the download", () => {
    const library = readThemeLibrary([a, b]);
    expect(() => replaceCollection(library, "open-vsx:demo.theme", [a], [a])).toThrow(/changed/);
  });

  it("refuses themes outside the collection, repeated ids and ids taken elsewhere", () => {
    const library = readThemeLibrary([theme("Demo Light")]);
    expect(() => replaceCollection(library, "open-vsx:demo.theme", [theme("Other")])).toThrow(/invalid/);
    expect(() => replaceCollection(library, "open-vsx:demo.theme", [a, a])).toThrow(/invalid/);
    expect(() => replaceCollection(library, "open-vsx:demo.theme", [a])).toThrow(/already installed/);
    expect(() => replaceCollection(library, "open-vsx:demo.theme", [])).toThrow(/empty/);
  });
});
