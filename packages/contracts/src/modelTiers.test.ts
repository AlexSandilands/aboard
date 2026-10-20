import { describe, expect, it } from "vitest";
import { CLI_EFFORTS, CliEffort, ModelTierSetting } from "./modelTiers.ts";
import { ModelProfile } from "./modelProfiles.ts";

describe("cli effort", () => {
  it("parses settings saved before it existed, and ones that carry it", () => {
    const old = { description: null, t3: null, cli: { "claude-code": "opus" } };
    expect(ModelTierSetting.parse(old)).toEqual(old);
    const withEffort = { ...old, cliEffort: { "claude-code": "high" } };
    expect(ModelTierSetting.parse(withEffort).cliEffort).toEqual({ "claude-code": "high" });
  });

  it("refuses a level no CLI takes, on a tier and on a custom model", () => {
    const base = { description: null, t3: null };
    expect(ModelTierSetting.safeParse({ ...base, cliEffort: { "claude-code": "huge" } }).success).toBe(false);
    const profile = { id: "x", name: "X", ...base };
    expect(ModelProfile.safeParse({ ...profile, cliEffort: { "copilot-cli": "ultra" } }).success).toBe(false);
    expect(ModelProfile.parse({ ...profile, cliEffort: { "copilot-cli": "none" } }).cliEffort).toEqual({
      "copilot-cli": "none",
    });
  });

  it("lists only valid levels for each harness", () => {
    for (const levels of Object.values(CLI_EFFORTS)) {
      for (const level of levels) expect(CliEffort.safeParse(level).success).toBe(true);
    }
    expect(CLI_EFFORTS["claude-code"]).not.toContain("none");
  });
});
