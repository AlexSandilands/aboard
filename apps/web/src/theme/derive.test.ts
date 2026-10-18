import { describe, expect, it } from "vitest";
import { getThemeEditorColorFamily, THEME_EDITOR_ROLE_GROUPS } from "~/components/settings/themeEditor.logic";
import { getStandardThemeColors, themeColorToHex, toCanonicalThemeColor } from "./color";
import { createVividThemeColors, updateThemeColorFamily } from "./derive";
import { THEME_COLOR_ROLES, type ThemeColorRole } from "./palettes";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex.slice(0, 7);
}

function contrast(first: string, second: string): number {
  const luminance = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2]
      .map((i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  };
  const [a, b] = [luminance(first), luminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Seeds from T3 Code's own suite, including canvases that disagree with the appearance asked for.
const SEEDS: ReadonlyArray<["light" | "dark", string, string]> = [
  ["light", "#f4f9f2", "#1d8a4e"],
  ["dark", "#101a2c", "#4f8fe8"],
  ["dark", "#211a23", "#df5398"],
  ["light", "#fdf6ec", "#c2571b"],
  ["light", "#111827", "#8ab4f8"],
  ["dark", "#f5ecf5", "#a84370"],
];

describe("createVividThemeColors", () => {
  it.each(SEEDS)("derives a readable %s palette from %s and %s", (appearance, canvas, accent) => {
    const colors = createVividThemeColors(appearance, canvas, accent);
    expect(Object.keys(colors).sort()).toEqual([...THEME_COLOR_ROLES].sort());
    for (const value of Object.values(colors)) expect(value).toMatch(/^oklch\(/);
    expect(asHex(colors.canvas)).toBe(canvas);
    expect(asHex(colors.accent)).toBe(accent);
    expect(asHex(colors.update)).toBe(accent);

    expect(contrast(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
    expect(contrast(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.textMuted, colors.canvas)).toBeLessThan(5.5);
    expect(contrast(colors.mutedForeground, colors.muted)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.placeholder, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    const pairs: Array<[ThemeColorRole, ThemeColorRole]> = [
      ["accentForeground", "accent"],
      ["searchMatchForeground", "searchMatchBackground"],
      ["searchMatchActiveForeground", "searchMatchActiveBackground"],
      ["messageActionForeground", "messageAction"],
      ["messageForeground", "messageSurface"],
      ["secondaryForeground", "secondary"],
      ["sidebarForeground", "sidebar"],
      ["errorForeground", "errorSurface"],
      ["warningForeground", "warningSurface"],
    ];
    for (const [foreground, background] of pairs) {
      expect(contrast(colors[foreground], colors[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    expect(colors.messageAction).not.toBe(colors.accent);
    expect(colors.secondaryLabel).toBe(colors.textMuted);
  });

  it("falls back to its own seeds when a colour doesn't parse", () => {
    const colors = createVividThemeColors("dark", "not a colour", "nope");
    expect(asHex(colors.canvas)).toBe("#180f1b");
    expect(contrast(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
  });
});

describe("updateThemeColorFamily", () => {
  const base = getStandardThemeColors("dark");

  /** The roles that changed between two palettes. */
  const changed = (next: Record<ThemeColorRole, string>) =>
    THEME_COLOR_ROLES.filter((role) => next[role] !== base[role]);

  it("normalises the edited colour to oklch", () => {
    expect(updateThemeColorFamily("dark", base, "surface", "#123456").surface).toBe(toCanonicalThemeColor("#123456"));
  });

  it("keeps a half-typed value as typed and leaves the rest alone", () => {
    const next = updateThemeColorFamily("dark", base, "accent", "#12");
    expect(next.accent).toBe("#12");
    expect(changed(next)).toEqual(["accent"]);
  });

  it.each(THEME_EDITOR_ROLE_GROUPS.flatMap((group) => group.families).map((family) => [family.label, family] as const))(
    "moves only %s's own roles",
    (_label, family) => {
      const next = updateThemeColorFamily("dark", base, family.role, "#7a3cff");
      for (const role of changed(next)) expect(family.roles).toContain(role);
      expect(changed(next)).toContain(family.role);
    },
  );

  it("copies text, borders and the canvas onto their linked roles", () => {
    const text = updateThemeColorFamily("dark", base, "text", "#eeeeee");
    expect(text.toolbarForeground).toBe(text.text);
    expect(text.toolbarControlForeground).toBe(text.text);
    const border = updateThemeColorFamily("dark", base, "border", "#333333");
    expect([border.toolbarBorder, border.sidebarBorder]).toEqual([border.border, border.border]);
    const canvas = updateThemeColorFamily("dark", base, "canvas", "#101010");
    expect([canvas.chrome, canvas.toolbar]).toEqual([canvas.canvas, canvas.canvas]);
  });

  it.each(["#ffffff", "#000000", "#3366cc"])("keeps foregrounds readable on a new %s surface", (value) => {
    const pairs: Array<[ThemeColorRole, ThemeColorRole]> = [
      ["secondary", "secondaryForeground"],
      ["accentSurface", "accentSurfaceForeground"],
      ["messageSurface", "messageForeground"],
      ["codeBackground", "codeForeground"],
      ["sidebar", "sidebarForeground"],
      ["searchMatchBackground", "searchMatchForeground"],
      ["messageAction", "messageActionForeground"],
    ];
    for (const [role, foreground] of pairs) {
      const next = updateThemeColorFamily("dark", base, role, value);
      expect(contrast(next[foreground], next[role]), `${foreground} on ${role}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("composites a translucent search match onto the canvas", () => {
    const next = updateThemeColorFamily("dark", base, "searchMatchBackground", "#33669980");
    expect(next.searchMatchBackground).not.toContain("/");
    expect(contrast(next.searchMatchForeground, next.searchMatchBackground)).toBeGreaterThanOrEqual(4.5);
  });

  it("solves status text against its tinted surface", () => {
    for (const role of ["error", "warning"] as const) {
      const next = updateThemeColorFamily("dark", base, role, role === "error" ? "#ff3355" : "#ffaa00");
      expect(contrast(next[`${role}Foreground`], next[`${role}Surface`])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("finds the family of any linked role", () => {
    expect(getThemeEditorColorFamily("sidebarMutedForeground")?.role).toBe("mutedForeground");
    expect(getThemeEditorColorFamily("terminalCursor")?.role).toBe("accent");
  });
});
