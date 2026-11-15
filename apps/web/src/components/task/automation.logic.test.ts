import { describe, expect, it } from "vitest";
import { automationUpdate, mayState } from "./automation.logic";

describe("mayState", () => {
  it("reads Default as off for start and merge, and follows the board for review", () => {
    const none = { autopilot: null, autoReview: null, autoMerge: null };
    expect(mayState(none, false)).toEqual({ start: false, review: false, merge: false });
    expect(mayState(none, true)).toEqual({ start: false, review: true, merge: false });
  });

  it("shows an explicit On as on and an explicit Off as off", () => {
    expect(mayState({ autopilot: true, autoReview: false, autoMerge: true }, true)).toEqual({
      start: true,
      review: false,
      merge: true,
    });
    expect(mayState({ autopilot: false, autoReview: null, autoMerge: false }, false)).toEqual({
      start: false,
      review: false,
      merge: false,
    });
  });
});

describe("automationUpdate", () => {
  it("turns start and merge on, and off back to Default", () => {
    expect(automationUpdate({ setting: "may", flag: "start", on: true }, false)).toEqual({ autopilot: true });
    expect(automationUpdate({ setting: "may", flag: "start", on: false }, false)).toEqual({ autopilot: null });
    expect(automationUpdate({ setting: "may", flag: "merge", on: true }, false)).toEqual({ autoMerge: true });
    expect(automationUpdate({ setting: "may", flag: "merge", on: false }, false)).toEqual({ autoMerge: null });
  });

  it("stores review only when it differs from the board's setting", () => {
    expect(automationUpdate({ setting: "may", flag: "review", on: true }, false)).toEqual({ autoReview: true });
    expect(automationUpdate({ setting: "may", flag: "review", on: false }, false)).toEqual({ autoReview: null });
    expect(automationUpdate({ setting: "may", flag: "review", on: false }, true)).toEqual({ autoReview: false });
    expect(automationUpdate({ setting: "may", flag: "review", on: true }, true)).toEqual({ autoReview: null });
  });

  it("writes the other settings to their own fields", () => {
    expect(automationUpdate({ setting: "reviewModel", model: { tier: "deep" } }, false)).toEqual({
      reviewModel: { tier: "deep" },
    });
    expect(automationUpdate({ setting: "reviewModel", model: null }, false)).toEqual({ reviewModel: null });
    expect(automationUpdate({ setting: "priority", on: true }, false)).toEqual({ priority: true });
    expect(automationUpdate({ setting: "manual", on: true }, false)).toEqual({ manual: true });
  });
});
