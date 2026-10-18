import { describe, expect, it } from "vitest";
import { parseThemeFile } from "~/theme/themeFile";
import {
  describeOversizedThemeFile,
  highlightJson,
  MAX_THEME_FILE_BYTES,
  nameFromFileName,
  parseImportedTheme,
  versionedCopy,
} from "./themeImport.logic";

const dusk = parseThemeFile({ version: 1, name: "Dusk", appearance: "dark", colors: { canvas: "#101018" } });

describe("theme import size guard", () => {
  it("accepts anything a theme file could plausibly be", () => {
    for (const bytes of [0, 4_096, MAX_THEME_FILE_BYTES]) expect(describeOversizedThemeFile(bytes)).toBeNull();
  });

  it("rejects a file too large to be a theme and names its size", () => {
    const message = describeOversizedThemeFile(100 * 1024 * 1024);
    expect(message).toContain("100.0 MB");
    expect(message).toContain("256 KB");
  });
});

describe("parseImportedTheme", () => {
  it("reads T3 Code theme files and converts VS Code ones", () => {
    expect(parseImportedTheme({ version: 1, name: "Dusk", appearance: "dark", colors: { canvas: "#101018" } }).id).toBe(
      "dusk",
    );
    const vscode = parseImportedTheme({ name: "Night Owl", type: "dark", colors: { "editor.background": "#011627" } });
    expect(vscode).toMatchObject({ id: "night-owl", appearance: "dark" });
  });

  it("refuses a reserved id", () => {
    expect(() =>
      parseImportedTheme({ version: 1, id: "ocean", name: "Ocean", appearance: "dark", colors: { canvas: "#000" } }),
    ).toThrow(/reserved/);
  });
});

describe("versionedCopy", () => {
  it("numbers copies past the ids already taken", () => {
    expect(versionedCopy(dusk, new Set(["dusk"])).label).toBe("Dusk (1)");
    expect(versionedCopy(dusk, new Set(["dusk", "dusk-1"])).label).toBe("Dusk (2)");
  });

  it("tries the file's name first, keeping the colours", () => {
    const copy = versionedCopy(dusk, new Set(["dusk"]), nameFromFileName("dusk-storm.json"));
    expect(copy).toMatchObject({ id: "dusk-storm", label: "Dusk Storm" });
    expect(copy.colors).toEqual(dusk.colors);
  });

  it("ignores a file name that is just the theme's own name", () => {
    expect(versionedCopy(dusk, new Set(["dusk"]), "dusk").label).toBe("Dusk (1)");
  });
});

describe("highlightJson", () => {
  it("escapes markup in values", () => {
    const html = highlightJson('{"name": "<img src=x onerror=alert(1)>"}');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
