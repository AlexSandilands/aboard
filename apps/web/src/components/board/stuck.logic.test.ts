import { describe, expect, it } from "vitest";
import { stuckHeight } from "./stuck.logic";

describe("stuckHeight", () => {
  it("isn't stuck until the lane has scrolled past the column header", () => {
    expect(stuckHeight({ natural: 1200, scrolled: 0, settled: 240 })).toBeNull();
    expect(stuckHeight({ natural: 1200, scrolled: -300, settled: 240 })).toBeNull();
  });

  it("gives up one pixel per pixel scrolled, so its bottom stays on the lanes under it", () => {
    expect(stuckHeight({ natural: 1200, scrolled: 1, settled: 240 })).toBe(1199);
    expect(stuckHeight({ natural: 1200, scrolled: 500, settled: 240 })).toBe(700);
  });

  it("stops at its settled height", () => {
    expect(stuckHeight({ natural: 1200, scrolled: 5000, settled: 240 })).toBe(240);
  });

  it("never grows a lane shorter than its settled height", () => {
    expect(stuckHeight({ natural: 150, scrolled: 20, settled: 240 })).toBe(150);
  });
});
