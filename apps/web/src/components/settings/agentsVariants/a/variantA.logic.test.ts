import type { ModelTierSetting } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { activeTab, modelsSet, savedModel, showsPreferred, tabForKey, tierProviderOf } from "./variantA.logic";

const setting = (patch: Partial<ModelTierSetting>): ModelTierSetting => ({ description: null, t3: null, ...patch });

describe("tierProviderOf", () => {
  it("names T3 Code as the tiers do and leaves the CLIs alone", () => {
    expect(tierProviderOf("t3-code")).toBe("t3");
    expect(tierProviderOf("codex")).toBe("codex");
  });
});

describe("activeTab", () => {
  it("keeps the asked-for tab while it is shown, else falls back to the first", () => {
    expect(activeTab(["t3", "codex"], "codex")).toBe("codex");
    expect(activeTab(["t3", "codex"], "claude-code")).toBe("t3");
    expect(activeTab(["t3", "codex"], null)).toBe("t3");
    expect(activeTab([], "codex")).toBeNull();
  });
});

describe("tabForKey", () => {
  const shown = ["t3", "claude-code", "codex"] as const;
  it("moves with the arrows, wrapping, and jumps with Home and End", () => {
    expect(tabForKey(shown, "t3", "ArrowRight")).toBe("claude-code");
    expect(tabForKey(shown, "codex", "ArrowRight")).toBe("t3");
    expect(tabForKey(shown, "t3", "ArrowLeft")).toBe("codex");
    expect(tabForKey(shown, "claude-code", "Home")).toBe("t3");
    expect(tabForKey(shown, "t3", "End")).toBe("codex");
  });
  it("ignores other keys and a tab that isn't shown", () => {
    expect(tabForKey(shown, "t3", "Enter")).toBeNull();
    expect(tabForKey(shown, "copilot-cli", "ArrowRight")).toBeNull();
  });
});

describe("showsPreferred", () => {
  it("needs two CLIs to choose between; T3 Code doesn't count", () => {
    expect(showsPreferred(["t3", "claude-code"])).toBe(false);
    expect(showsPreferred(["claude-code", "codex"])).toBe(true);
  });
});

describe("savedModel and modelsSet", () => {
  const profile = setting({
    t3: { selection: { instanceId: "codex", model: "gpt-6", options: [] }, label: "GPT-6" },
    cli: { "claude-code": " opus ", codex: "  " },
  });
  it("reads T3 Code's label and a CLI's trimmed model, with blank as the default", () => {
    expect(savedModel(profile, "t3")).toBe("GPT-6");
    expect(savedModel(profile, "claude-code")).toBe("opus");
    expect(savedModel(profile, "codex")).toBeNull();
    expect(savedModel(profile, "copilot-cli")).toBeNull();
  });
  it("lists only the shown providers with a model of their own, in tab order", () => {
    expect(modelsSet(profile, ["claude-code", "codex", "t3"])).toEqual([
      { provider: "claude-code", model: "opus" },
      { provider: "t3", model: "GPT-6" },
    ]);
  });
});
