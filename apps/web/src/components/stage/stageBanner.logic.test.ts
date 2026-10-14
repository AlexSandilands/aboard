import { describe, expect, it } from "vitest";
import { DEFAULT_STAGE_BANNER, STAGE_BANNERS, isStageBannerChoice, resolveStageBanner } from "./stageBanner.logic";

describe("isStageBannerChoice", () => {
  it("accepts banner ids and rotate", () => {
    for (const banner of STAGE_BANNERS) expect(isStageBannerChoice(banner.id)).toBe(true);
    expect(isStageBannerChoice("rotate")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isStageBannerChoice("sunrise")).toBe(false);
    expect(isStageBannerChoice(undefined)).toBe(false);
    expect(isStageBannerChoice(3)).toBe(false);
  });
});

describe("resolveStageBanner", () => {
  it("returns a fixed choice as is", () => {
    expect(resolveStageBanner("dusk")).toBe("dusk");
  });

  it("falls back to the default for unknown stored values", () => {
    expect(resolveStageBanner("retired-banner")).toBe(DEFAULT_STAGE_BANNER);
    expect(resolveStageBanner(null)).toBe(DEFAULT_STAGE_BANNER);
  });

  it("keeps the same banner for the whole local day", () => {
    const morning = resolveStageBanner("rotate", new Date(2026, 9, 14, 0, 5));
    const night = resolveStageBanner("rotate", new Date(2026, 9, 14, 23, 55));
    expect(night).toBe(morning);
  });

  it("visits every rotating banner over consecutive days, and never None", () => {
    const rotating = STAGE_BANNERS.filter((banner) => banner.rotates).map((banner) => banner.id);
    const seen = new Set(rotating.map((_, offset) => resolveStageBanner("rotate", new Date(2026, 9, 14 + offset, 12))));
    expect([...seen].toSorted()).toEqual(rotating.toSorted());
    expect(seen.has("none")).toBe(false);
  });
});
