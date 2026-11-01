import { describe, expect, it } from "vitest";
import { glideStartOffset, slideDurationMs } from "./sidebarSlide.logic";

describe("slideDurationMs", () => {
  it("scales the panel animation setting, so the default is 450 ms", () => {
    expect(slideDurationMs(150)).toBe(450);
    expect(slideDurationMs(400)).toBe(1200);
  });

  it("is off at 0", () => {
    expect(slideDurationMs(0)).toBe(0);
  });
});

describe("glideStartOffset", () => {
  const base = { current: 0, width: 256 };

  it("starts an opening left sidebar's main area to the left of where it sits", () => {
    expect(glideStartOffset({ ...base, opening: true, side: "left" })).toBe(-256);
  });

  it("starts a closing left sidebar's main area to the right", () => {
    expect(glideStartOffset({ ...base, opening: false, side: "left" })).toBe(256);
  });

  it("mirrors both for a right sidebar", () => {
    expect(glideStartOffset({ ...base, opening: true, side: "right" })).toBe(256);
    expect(glideStartOffset({ ...base, opening: false, side: "right" })).toBe(-256);
  });

  it("continues from a glide still running", () => {
    expect(glideStartOffset({ current: 100, width: 256, opening: false, side: "left" })).toBe(356);
    expect(glideStartOffset({ current: 100, width: 256, opening: true, side: "left" })).toBe(-156);
  });
});
