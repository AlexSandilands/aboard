import { describe, expect, it } from "vitest";

import { labelPan } from "./labelPan.logic";

describe("labelPan", () => {
  it("is null when the text fits", () => {
    expect(labelPan(100, 100)).toBeNull();
    expect(labelPan(80, 100)).toBeNull();
  });

  it("ignores overflow under a pixel", () => {
    expect(labelPan(100.4, 100)).toBeNull();
  });

  it("pans by the hidden width plus a pixel, so the end clears the ellipsis", () => {
    expect(labelPan(300, 120)?.distancePx).toBe(181);
  });

  it("takes longer for a longer overflow, within bounds", () => {
    const short = labelPan(105, 100)!;
    const medium = labelPan(300, 100)!;
    const huge = labelPan(100_000, 100)!;
    expect(short.cycleMs).toBe(1500);
    expect(medium.cycleMs).toBeGreaterThan(short.cycleMs);
    expect(huge.cycleMs).toBe(12000);
  });
});
