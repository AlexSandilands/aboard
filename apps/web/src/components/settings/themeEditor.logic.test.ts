import { describe, expect, it } from "vitest";
import { getStandardThemeColors } from "~/theme/color";
import { BUILT_IN_THEMES, getThemeModes, THEME_COLOR_ROLES } from "~/theme/palettes";
import { parseThemeFile } from "~/theme/themeFile";
import { collectionVariantLabels, groupCustomThemes } from "./themeCards.logic";
import {
  appearanceLockReason,
  buildEditedTheme,
  buildNewTheme,
  filterThemeEditorGroups,
  findMergeTarget,
  mergeIntoTheme,
  seedThemeEditor,
  THEME_EDITOR_ROLE_GROUPS,
} from "./themeEditor.logic";

const light = parseThemeFile({ version: 1, name: "Paper", appearance: "light", colors: { canvas: "#fafafa" } });
const dark = parseThemeFile({ version: 1, name: "Ink", appearance: "dark", colors: { canvas: "#101010" } });

describe("the colour families", () => {
  it("cover every role exactly once", () => {
    const roles = THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families.flatMap((family) => family.roles));
    expect(new Set(roles).size).toBe(roles.length);
    expect(THEME_COLOR_ROLES.filter((role) => !roles.includes(role))).toEqual([]);
  });

  it("filter by family and role names", () => {
    expect(filterThemeEditorGroups("sidebar").map((group) => group.id)).toEqual(["foundation", "context"]);
    expect(filterThemeEditorGroups("nothing like this")).toEqual([]);
  });
});

describe("seedThemeEditor", () => {
  it("starts from T3 Code's palettes in simple mode", () => {
    const seed = seedThemeEditor(null, "dark");
    expect(seed).toMatchObject({ appearance: "dark", advanced: false });
    expect(seed.colors.dark).toEqual(getStandardThemeColors("dark"));
  });

  it("opens imported themes in advanced mode and on an appearance they have", () => {
    const seed = seedThemeEditor(light, "dark");
    expect(seed).toMatchObject({ appearance: "light", advanced: true });
    expect(seed.colors.light).toEqual(light.colors);
  });

  it("opens managed themes in simple mode", () => {
    expect(seedThemeEditor({ ...dark, managed: true }, "dark").advanced).toBe(false);
  });
});

describe("merging by name", () => {
  it("finds another custom theme by id or label, never the one being edited", () => {
    expect(findMergeTarget(" paper ", [light, dark], null)?.id).toBe("paper");
    expect(findMergeTarget("Paper", [light], "paper")).toBeNull();
    expect(findMergeTarget("", [light], null)).toBeNull();
  });

  it("locks the appearances a merge target already has, and those an edited theme lacks", () => {
    expect(appearanceLockReason("light", null, light)).toMatch(/already has a light palette/);
    expect(appearanceLockReason("dark", null, light)).toBeNull();
    expect(appearanceLockReason("dark", light, null)).toMatch(/has no dark palette/);
  });

  it("adds the palette as the target's other appearance", () => {
    const merged = mergeIntoTheme({ ...light, managed: true }, { dark: dark.colors }, true);
    expect(merged).toMatchObject({ id: "paper", appearance: "light", managed: true });
    expect(getThemeModes(merged)).toEqual(["light", "dark"]);
    expect(merged.variants?.dark?.canvas).toBe(dark.colors.canvas);
    expect(mergeIntoTheme({ ...light, managed: true }, { dark: dark.colors }, false).managed).toBeUndefined();
  });
});

describe("saving", () => {
  it("rewrites an edited theme under its id with both palettes and its collection", () => {
    const both = { ...mergeIntoTheme(light, { dark: dark.colors }, false), collection: { id: "c", label: "C" } };
    const saved = buildEditedTheme(both, "Paper 2", { light: light.colors, dark: dark.colors }, true);
    expect(saved).toMatchObject({ id: "paper", label: "Paper 2", managed: true, collection: { id: "c" } });
    expect(getThemeModes(saved)).toEqual(["light", "dark"]);
  });

  it("creates a single-appearance theme from the active palette", () => {
    const created = buildNewTheme("Aurora", "dark", dark.colors, false);
    expect(created).toMatchObject({ id: "aurora", appearance: "dark" });
    expect(created.variants).toBeUndefined();
    expect(created.managed).toBeUndefined();
  });
});

describe("theme cards", () => {
  it("groups a collection's themes onto one card, in saved order", () => {
    const inC = (name: string) => ({
      ...parseThemeFile({ version: 1, name, appearance: "dark", colors: { canvas: "#000" } }),
      collection: { id: "c", label: "Cat" },
    });
    const groups = groupCustomThemes([light, inC("Cat Mocha"), dark, inC("Cat Latte")]);
    expect(groups.map(([key, themes]) => [key, themes.map((t) => t.id)])).toEqual([
      ["theme:paper", ["paper"]],
      ["collection:c", ["cat-mocha", "cat-latte"]],
      ["theme:ink", ["ink"]],
    ]);
  });

  it("shortens variant labels to what tells them apart", () => {
    const named = (label: string) => ({ ...BUILT_IN_THEMES[0]!, label });
    expect(collectionVariantLabels([named("Catppuccin Mocha"), named("Catppuccin Latte")])).toEqual(["Mocha", "Latte"]);
    expect(collectionVariantLabels([named("Dracula"), named("Dracula")])).toEqual(["Dracula", "Dracula"]);
  });
});
