import { CLI_EFFORTS } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT,
  effortAfterModelChange,
  effortItems,
  effortLabel,
  effortOfValue,
  initialEffort,
} from "./cliEffort.logic";

describe("effortItems", () => {
  it("lists the default first, then the levels", () => {
    expect(effortItems(["low", "high"], null)).toEqual([
      { value: DEFAULT_EFFORT, label: "Default effort" },
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ]);
  });

  it("keeps a chosen level the list doesn't have, so it can be seen and cleared", () => {
    expect(effortItems(["low"], "max").map((item) => item.value)).toEqual([DEFAULT_EFFORT, "max", "low"]);
    expect(effortItems(["low", "max"], "max").map((item) => item.value)).toEqual([DEFAULT_EFFORT, "low", "max"]);
  });
});

describe("effortLabel", () => {
  it("names every level", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("none")).toBe("None");
  });
});

describe("effortOfValue", () => {
  it("reads a level, and anything else as the default", () => {
    expect(effortOfValue("xhigh")).toBe("xhigh");
    expect(effortOfValue("none")).toBe("none");
    expect(effortOfValue(DEFAULT_EFFORT)).toBeNull();
    expect(effortOfValue(null)).toBeNull();
    expect(effortOfValue(4)).toBeNull();
  });
});

describe("initialEffort", () => {
  const options = { efforts: { "claude-code": "high" as const, "copilot-cli": null } };

  it("takes the model's effort when working, and the default when planning", () => {
    expect(initialEffort(options, "claude-code", false)).toBe("high");
    expect(initialEffort(options, "claude-code", true)).toBeNull();
    expect(initialEffort(options, "copilot-cli", false)).toBeNull();
  });

  it("is the default from a server that sends no efforts", () => {
    expect(initialEffort({}, "claude-code", false)).toBeNull();
  });
});

describe("effortAfterModelChange", () => {
  it("keeps an effort the model still takes and drops one it doesn't", () => {
    expect(effortAfterModelChange("high", CLI_EFFORTS["claude-code"])).toBe("high");
    expect(effortAfterModelChange("none", CLI_EFFORTS["claude-code"])).toBeNull();
    expect(effortAfterModelChange(null, CLI_EFFORTS["claude-code"])).toBeNull();
  });
});
