import { EMPTY_MODEL_TIERS, type ModelTiers } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  headlessModelForOption,
  headlessModelItems,
  headlessModelOption,
  headlessModelRun,
  typedHeadlessModel,
} from "./headlessModel.logic";

const tiers: ModelTiers = {
  ...EMPTY_MODEL_TIERS,
  light: { description: null, t3: null, cli: { "claude-code": "haiku" } },
};

describe("headless model picker", () => {
  it("offers the CLI default only where no choice is a setting", () => {
    expect(headlessModelItems(true).map((i) => i.value)).toEqual(["default", "light", "standard", "deep", "custom"]);
    expect(headlessModelItems(false).map((i) => i.value)).toEqual(["light", "standard", "deep", "custom"]);
  });

  it("shows the option a stored choice is", () => {
    expect(headlessModelOption(null)).toBe("default");
    expect(headlessModelOption({ tier: "deep" })).toBe("deep");
    expect(headlessModelOption({ model: "opus" })).toBe("custom");
    // Custom picked, nothing typed yet: the stored choice is still the old one.
    expect(headlessModelOption({ tier: "deep" }, true)).toBe("custom");
  });

  it("saves a tier or no choice at once, and a custom model only once there is a name", () => {
    expect(headlessModelForOption("light", null)).toEqual({ tier: "light" });
    expect(headlessModelForOption("default", { tier: "light" })).toBeNull();
    expect(headlessModelForOption("custom", { tier: "light" })).toBeUndefined();
    expect(headlessModelForOption("custom", null)).toBeUndefined();
    expect(headlessModelForOption("custom", { model: "opus" })).toEqual({ model: "opus" });
    expect(headlessModelForOption("bogus", null)).toBeUndefined();
  });

  it("saves a typed model trimmed, and nothing for a blank or unsafe one", () => {
    expect(typedHeadlessModel("  haiku ")).toEqual({ model: "haiku" });
    expect(typedHeadlessModel("")).toBeNull();
    expect(typedHeadlessModel("a b")).toBeNull();
    expect(typedHeadlessModel("x; y")).toBeNull();
  });

  it("says what a choice runs, and when a tier falls back to the CLI default", () => {
    expect(headlessModelRun(tiers, null)).toEqual({ kind: "default" });
    expect(headlessModelRun(tiers, { model: "opus" })).toEqual({ kind: "model", model: "opus" });
    expect(headlessModelRun(tiers, { tier: "light" })).toEqual({
      kind: "tier",
      tier: "light",
      label: "Light",
      model: "haiku",
    });
    expect(headlessModelRun(tiers, { tier: "deep" })).toEqual({ kind: "tier-unset", tier: "deep", label: "Deep" });
  });
});
