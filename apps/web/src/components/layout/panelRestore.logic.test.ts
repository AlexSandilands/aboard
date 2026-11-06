import { describe, expect, it } from "vitest";
import { panelRestored } from "./panelRestore.logic";

describe("panelRestored", () => {
  it("restores the task the board was left on", () => {
    expect(panelRestored("t1", "t1", false)).toBe(true);
  });
  it("slides in a different task than the one left", () => {
    expect(panelRestored("t2", "t1", false)).toBe(false);
  });
  it("slides in a task opened when none was left open", () => {
    expect(panelRestored("t2", undefined, false)).toBe(false);
  });
  it("restores on the app's first load with a task", () => {
    expect(panelRestored("t1", undefined, true)).toBe(true);
  });
  it("has nothing to restore without a task", () => {
    expect(panelRestored(null, "t1", true)).toBe(false);
  });
});
