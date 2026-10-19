import { describe, expect, it } from "vitest";
import { isStuck } from "./stuck.logic";

describe("isStuck", () => {
  it("is stuck once the sentinel has scrolled up past the column header", () => {
    expect(isStuck({ isIntersecting: false, top: -40, rootTop: 37 })).toBe(true);
  });

  it("is not stuck while the sentinel is in view", () => {
    expect(isStuck({ isIntersecting: true, top: 200, rootTop: 37 })).toBe(false);
  });

  it("is not stuck when the sentinel is below the visible area", () => {
    expect(isStuck({ isIntersecting: false, top: 900, rootTop: 37 })).toBe(false);
  });
});
