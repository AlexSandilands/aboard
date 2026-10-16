import { describe, expect, it } from "vitest";
import { AUTOPILOT_OPTIONS, autopilotChoice, autopilotValue } from "./autopilot.logic";

describe("the per-task Autopilot flag", () => {
  it("round-trips every choice through the stored value", () => {
    for (const { value } of AUTOPILOT_OPTIONS) expect(autopilotChoice(autopilotValue(value))).toBe(value);
  });

  it("stores Default as null so only On opts the task in", () => {
    expect(autopilotValue("default")).toBeNull();
    expect(autopilotValue("on")).toBe(true);
    expect(autopilotValue("off")).toBe(false);
  });
});
