import { describe, expect, it } from "vitest";
import { AUTO_MERGE_OPTIONS, AUTOPILOT_OPTIONS, autopilotChoice, autopilotValue } from "./autopilot.logic";

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

describe("the per-task auto-merge flag", () => {
  it("offers the same choices as the Autopilot flag, with Default reading as off", () => {
    expect(AUTO_MERGE_OPTIONS.map((o) => o.value)).toEqual(AUTOPILOT_OPTIONS.map((o) => o.value));
    expect(AUTO_MERGE_OPTIONS[0]?.label).toBe("Default (off)");
  });
});
