import { describe, expect, it } from "vitest";
import { moreSide } from "./tableScroll.logic";

describe("moreSide", () => {
  it("is nothing when the table fits", () => {
    expect(moreSide({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 })).toBeUndefined();
    expect(moreSide({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400.5 })).toBeUndefined();
  });

  it("names the edges with more content", () => {
    expect(moreSide({ scrollLeft: 0, clientWidth: 400, scrollWidth: 600 })).toBe("right");
    expect(moreSide({ scrollLeft: 100, clientWidth: 400, scrollWidth: 600 })).toBe("both");
    expect(moreSide({ scrollLeft: 200, clientWidth: 400, scrollWidth: 600 })).toBe("left");
    expect(moreSide({ scrollLeft: 199.5, clientWidth: 400, scrollWidth: 600 })).toBe("left");
  });
});
