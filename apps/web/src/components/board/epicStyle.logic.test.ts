import { describe, expect, it } from "vitest";
import { epicAccentHue, epicAccentStyle } from "./epicStyle.logic";

describe("epicAccentHue", () => {
  it("is stable for a title", () => {
    expect(epicAccentHue("One-page checkout")).toBe(epicAccentHue("One-page checkout"));
  });

  it("never lands near the selection blue", () => {
    for (let i = 0; i < 500; i++) {
      const hue = epicAccentHue(`Epic ${i}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(hue >= 195 && hue < 285).toBe(false);
    }
  });

  it("reaches both sides of the avoided arc", () => {
    const hues = Array.from({ length: 500 }, (_, i) => epicAccentHue(`Epic ${i}`));
    expect(hues.some((h) => h >= 285)).toBe(true);
    expect(hues.some((h) => h < 195)).toBe(true);
  });
});

it("epicAccentStyle sets the colour from the hue", () => {
  expect(epicAccentStyle("x")).toEqual({ "--epic-accent": `oklch(0.62 0.16 ${epicAccentHue("x")})` });
});
