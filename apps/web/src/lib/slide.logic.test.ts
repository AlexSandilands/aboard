import { describe, expect, it } from "vitest";
import { gapStartWidth, slideDurationForDistance, slideDurationMs, slideStartOffset } from "./slide.logic";

describe("slideDurationMs", () => {
  it("scales the panel animation setting, so the default is 450 ms", () => {
    expect(slideDurationMs(150)).toBe(450);
    expect(slideDurationMs(400)).toBe(1200);
  });

  it("is off at 0", () => {
    expect(slideDurationMs(0)).toBe(0);
  });
});

describe("slideStartOffset", () => {
  const base = { current: 0, width: 256 };

  it("starts an opening left sidebar a width to the left of where it rests", () => {
    expect(slideStartOffset({ ...base, opening: true, side: "left" })).toBe(-256);
  });

  it("starts a closing left sidebar a width to the right of its hidden place", () => {
    expect(slideStartOffset({ ...base, opening: false, side: "left" })).toBe(256);
  });

  it("mirrors both for a right sidebar", () => {
    expect(slideStartOffset({ ...base, opening: true, side: "right" })).toBe(256);
    expect(slideStartOffset({ ...base, opening: false, side: "right" })).toBe(-256);
  });

  it("continues from a slide still running", () => {
    expect(slideStartOffset({ current: 100, width: 256, opening: false, side: "left" })).toBe(356);
    expect(slideStartOffset({ current: 100, width: 256, opening: true, side: "left" })).toBe(-156);
  });
});

describe("slideDurationForDistance", () => {
  it("runs the full duration from a standing start", () => {
    expect(slideDurationForDistance(450, 256, 256)).toBe(450);
    expect(slideDurationForDistance(450, -256, 256)).toBe(450);
  });

  it("shortens a reversal in proportion to the distance left", () => {
    expect(slideDurationForDistance(450, -64, 256)).toBe(112.5);
  });

  it("never runs longer than the full duration", () => {
    expect(slideDurationForDistance(450, 300, 256)).toBe(450);
  });
});

describe("gapStartWidth", () => {
  it("starts an opening gap shut and a closing one at full width", () => {
    expect(gapStartWidth({ from: -256, width: 256, opening: true })).toBe(0);
    expect(gapStartWidth({ from: 256, width: 256, opening: false })).toBe(256);
  });

  it("matches the part of the sidebar on screen when a slide turns around", () => {
    // Closing turned back 100 px into the slide: 156 px of the sidebar still show.
    expect(gapStartWidth({ from: -100, width: 256, opening: true })).toBe(156);
    expect(gapStartWidth({ from: 156, width: 256, opening: false })).toBe(156);
  });
});
