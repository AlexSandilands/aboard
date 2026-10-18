import { describe, expect, it } from "vitest";
import { automationUpdate } from "./automation.logic";

describe("automationUpdate", () => {
  it("writes each setting to its own field", () => {
    expect(automationUpdate({ setting: "autopilot", choice: "on" })).toEqual({ autopilot: true });
    expect(automationUpdate({ setting: "autoMerge", choice: "off" })).toEqual({ autoMerge: false });
    expect(automationUpdate({ setting: "autoReview", choice: "on" })).toEqual({ autoReview: true });
    expect(automationUpdate({ setting: "priority", on: true })).toEqual({ priority: true });
  });

  it("stores Default and Inherit as null", () => {
    expect(automationUpdate({ setting: "autopilot", choice: "default" })).toEqual({ autopilot: null });
    expect(automationUpdate({ setting: "autoMerge", choice: "default" })).toEqual({ autoMerge: null });
    expect(automationUpdate({ setting: "autoReview", choice: "inherit" })).toEqual({ autoReview: null });
  });
});
