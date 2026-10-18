import { describe, expect, it } from "vitest";
import {
  APPEARANCE_STYLE_PROPERTIES,
  appearancePaint,
  clampSetting,
  CONTRAST,
  cssFontFamilies,
  DEFAULT_APPEARANCE_PREFS,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  GLASS_OPACITY,
  normalizeAppearancePrefs,
  PANEL_ANIMATION_MS,
} from "./appearance.logic";

const prefs = (over: Partial<typeof DEFAULT_APPEARANCE_PREFS> = {}) => ({ ...DEFAULT_APPEARANCE_PREFS, ...over });

describe("clampSetting", () => {
  it("rounds to the step and keeps it in range", () => {
    expect(clampSetting(123, CONTRAST)).toBe(125);
    expect(clampSetting(10, CONTRAST)).toBe(50);
    expect(clampSetting(999, CONTRAST)).toBe(200);
    expect(clampSetting(110, PANEL_ANIMATION_MS)).toBe(100);
  });

  it("falls back to the default for anything not a number", () => {
    expect(clampSetting("90", GLASS_OPACITY)).toBe(80);
    expect(clampSetting(Number.NaN, GLASS_OPACITY)).toBe(80);
    expect(clampSetting(undefined, CONTRAST)).toBe(100);
  });
});

describe("normalizeAppearancePrefs", () => {
  it("fills in what an older save doesn't have", () => {
    expect(normalizeAppearancePrefs({})).toEqual(DEFAULT_APPEARANCE_PREFS);
  });

  it("clamps out-of-range values and drops non-string fonts", () => {
    expect(
      normalizeAppearancePrefs({ contrast: 500, fontSize: 9, fontSans: 42, fontMono: "x".repeat(300) }),
    ).toMatchObject({ contrast: 200, fontSize: 12, fontSans: "", fontMono: "x".repeat(200) });
  });
});

describe("cssFontFamilies", () => {
  it("quotes names that need it and keeps plain and quoted ones", () => {
    expect(cssFontFamilies("Inter, JetBrains Mono, 'Fira Code'")).toBe("Inter, \"JetBrains Mono\", 'Fira Code'");
  });

  it("strips characters that could break out of the declaration", () => {
    expect(cssFontFamilies('Evil"; color: red; {x}')).toBe('"Evil color: red x"');
  });

  it("is null when nothing is left", () => {
    expect(cssFontFamilies(" , ,")).toBeNull();
    expect(cssFontFamilies("")).toBeNull();
  });
});

describe("appearancePaint", () => {
  it("leaves the stylesheet's defaults alone for default prefs", () => {
    expect(appearancePaint(DEFAULT_APPEARANCE_PREFS, false)).toEqual({
      style: { "--panel-animation-duration": "150ms" },
      data: { "panel-animations": "true" },
    });
  });

  it("fades below 100% contrast and boosts above it, borders a quarter as fast", () => {
    expect(appearancePaint(prefs({ contrast: 60 }), false).style).toMatchObject({
      "--appearance-contrast-base": "60%",
      "--appearance-contrast-boost": "0%",
      "--appearance-contrast-border-boost": "0%",
    });
    expect(appearancePaint(prefs({ contrast: 180 }), false).style).toMatchObject({
      "--appearance-contrast-base": "100%",
      "--appearance-contrast-boost": "80%",
      "--appearance-contrast-border-boost": "20%",
    });
  });

  it("turns the blur off only for fully opaque glass", () => {
    expect(appearancePaint(prefs({ glassOpacity: 60 }), false).style).toMatchObject({ "--glass-opacity": "60%" });
    expect(appearancePaint(prefs({ glassOpacity: 60 }), false).style["--glass-blur"]).toBeUndefined();
    expect(appearancePaint(prefs({ glassOpacity: 100 }), false).style).toMatchObject({ "--glass-blur": "0px" });
  });

  it("puts typed fonts in front of the default stacks and sets the root size", () => {
    const { style } = appearancePaint(prefs({ fontSans: "Inter", fontMono: "Fira Code", fontSize: 14 }), false);
    expect(style["--font-sans"]).toBe(`Inter, ${DEFAULT_SANS_FONT_STACK}`);
    expect(style["--font-mono"]).toBe(`"Fira Code", ${DEFAULT_MONO_FONT_STACK}`);
    expect(style["font-size"]).toBe("14px");
  });

  it("animates panels only with a duration and without reduced motion", () => {
    expect(appearancePaint(prefs({ panelAnimationMs: 200 }), false)).toMatchObject({
      style: { "--panel-animation-duration": "200ms" },
      data: { "panel-animations": "true" },
    });
    expect(appearancePaint(prefs({ panelAnimationMs: 200 }), true).data["panel-animations"]).toBe("false");
  });

  it("only sets properties the runtime knows to clear", () => {
    const { style } = appearancePaint(
      prefs({ contrast: 150, glassOpacity: 100, panelAnimationMs: 100, fontSans: "A", fontMono: "B", fontSize: 18 }),
      false,
    );
    expect(Object.keys(style).sort()).toEqual([...APPEARANCE_STYLE_PROPERTIES].sort());
  });
});
