import { describe, expect, it } from "vitest";
import { shouldStepBack } from "./socialNavigation.logic";

describe("shouldStepBack", () => {
  it("steps back when opened from Settings and history allows it", () => {
    expect(shouldStepBack({ socialFromSettings: true }, true)).toBe(true);
  });

  it("goes to the board when opened by URL or after losing history", () => {
    expect(shouldStepBack({}, true)).toBe(false);
    expect(shouldStepBack({ socialFromSettings: true }, false)).toBe(false);
  });
});
