import { EMPTY_MODEL_TIERS, type ModelTierSetting, type ProviderSetting } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { activeProviders, modelSummary, preferredChoices, providerModelText, t3FieldText } from "./b.logic";

const provider = (id: ProviderSetting["id"], enabled = true): ProviderSetting => ({ id, enabled, cliPath: null });

const setting = (patch: Partial<ModelTierSetting> = {}): ModelTierSetting => ({ ...EMPTY_MODEL_TIERS.light, ...patch });

describe("activeProviders", () => {
  it("lists the providers added and on, T3 Code first", () => {
    expect(activeProviders([provider("codex"), provider("t3-code"), provider("claude-code", false)])).toEqual([
      "t3",
      "codex",
    ]);
  });
});

describe("preferredChoices", () => {
  it("offers the CLI providers that are on, never T3 Code", () => {
    expect(preferredChoices([provider("t3-code"), provider("claude-code"), provider("codex")], undefined)).toEqual([
      { harness: "claude-code", label: "Claude Code", available: true },
      { harness: "codex", label: "Codex", available: true },
    ]);
  });

  it("keeps a saved provider that is off or not added, marked", () => {
    expect(preferredChoices([provider("claude-code"), provider("codex", false)], "codex")).toEqual([
      { harness: "claude-code", label: "Claude Code", available: true },
      { harness: "codex", label: "Codex (off)", available: false },
    ]);
    expect(preferredChoices([provider("claude-code")], "copilot-cli").at(-1)).toEqual({
      harness: "copilot-cli",
      label: "Copilot CLI (not added)",
      available: false,
    });
  });
});

describe("providerModelText", () => {
  it("names the model with its effort, or the provider's default", () => {
    expect(providerModelText(setting(), "codex")).toBe("default");
    expect(providerModelText(setting({ cli: { codex: "gpt-5.4" } }), "codex")).toBe("gpt-5.4");
    expect(providerModelText(setting({ cli: { codex: "gpt-5.4" }, cliEffort: { codex: "high" } }), "codex")).toBe(
      "gpt-5.4, high",
    );
  });

  it("uses T3 Code's saved label", () => {
    const t3 = { selection: { instanceId: "x", model: "m", options: [] }, label: "GPT-5.4" };
    expect(providerModelText(setting({ t3: t3 as unknown as ModelTierSetting["t3"] }), "t3")).toBe("GPT-5.4");
    expect(providerModelText(setting(), "t3")).toBe("default");
  });
});

describe("modelSummary", () => {
  it("joins each shown provider's model on one line, marking the preferred one", () => {
    const value = setting({ cli: { codex: "gpt-5.4" }, provider: "codex" });
    expect(modelSummary(value, ["claude-code", "codex"])).toBe("Claude Code: default · Codex: gpt-5.4 (preferred)");
    expect(modelSummary(value, [])).toBe("");
  });
});

describe("t3FieldText", () => {
  it("says not connected, loading, the error or the saved label", () => {
    expect(t3FieldText(false, null, null)).toEqual({ text: "Not connected", muted: true });
    expect(t3FieldText(true, null, null)).toEqual({ text: "Loading models…", muted: true });
    expect(t3FieldText(true, "Boom", "GPT")).toEqual({ text: "Boom", muted: true });
    expect(t3FieldText(false, null, "GPT")).toEqual({ text: "GPT", muted: false });
  });
});
