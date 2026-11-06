import { CLI_EFFORTS } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { effortAfterModelChange, effortLabel, initialEffort } from "./cliEffort.logic";

describe("effortLabel", () => {
  it("names every level", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("none")).toBe("None");
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
