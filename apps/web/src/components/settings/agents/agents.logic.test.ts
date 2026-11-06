import { EMPTY_MODEL_TIERS, type ModelTierSetting } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  isT3DefaultKey,
  modelItemOfTarget,
  modelSummary,
  preferredChoices,
  sameModelItem,
  selectedModelItem,
  t3PlaceholderLabel,
  withT3DefaultRows,
} from "./agents.logic";

describe("modelItemOfTarget", () => {
  it("names a tier or a custom model from its settings target", () => {
    expect(modelItemOfTarget("agents.models.tiers.deep")).toEqual({ kind: "tier", tier: "deep" });
    expect(modelItemOfTarget("agents.models.custom.codex-6-1")).toEqual({ kind: "custom", id: "codex-6-1" });
  });

  it("names nothing for the lists, other pages or an unknown tier", () => {
    expect(modelItemOfTarget("agents.models.tiers.list")).toBeNull();
    expect(modelItemOfTarget("agents.models.tiers")).toBeNull();
    expect(modelItemOfTarget("agents.models")).toBeNull();
    expect(modelItemOfTarget("agents.providers.codex.models")).toBeNull();
    expect(modelItemOfTarget(null)).toBeNull();
  });
});

describe("selectedModelItem", () => {
  const profiles = [{ id: "fast" }];

  it("keeps a picked tier or an existing custom model", () => {
    expect(selectedModelItem({ kind: "tier", tier: "deep" }, profiles)).toEqual({ kind: "tier", tier: "deep" });
    expect(selectedModelItem({ kind: "custom", id: "fast" }, profiles)).toEqual({ kind: "custom", id: "fast" });
  });

  it("falls back to the first tier with nothing picked or a deleted custom model", () => {
    expect(selectedModelItem(null, profiles)).toEqual({ kind: "tier", tier: "light" });
    expect(selectedModelItem({ kind: "custom", id: "gone" }, profiles)).toEqual({ kind: "tier", tier: "light" });
  });

  it("compares items by kind and key", () => {
    expect(sameModelItem({ kind: "tier", tier: "deep" }, { kind: "tier", tier: "deep" })).toBe(true);
    expect(sameModelItem({ kind: "tier", tier: "deep" }, { kind: "custom", id: "deep" })).toBe(false);
    expect(sameModelItem({ kind: "custom", id: "a" }, { kind: "custom", id: "b" })).toBe(false);
  });
});

describe("modelSummary", () => {
  const t3 = {
    selection: { instanceId: "codex", model: "gpt-5.4", options: [] },
    label: "GPT-5.4",
  } as unknown as NonNullable<ModelTierSetting["t3"]>;

  it("prefers the user's description", () => {
    const setting = { ...EMPTY_MODEL_TIERS.light, description: " Sonnet, medium ", cli: { codex: "gpt-5" } };
    expect(modelSummary(setting, ["codex"])).toBe("Sonnet, medium");
  });

  it("lists the models set on the shown providers, in their order", () => {
    const setting = { ...EMPTY_MODEL_TIERS.light, t3, cli: { "claude-code": "sonnet", codex: "  " } };
    expect(modelSummary(setting, ["t3", "claude-code", "codex"])).toBe("GPT-5.4 · sonnet");
    expect(modelSummary(setting, ["codex"])).toBe("Provider defaults");
  });
});

describe("preferredChoices", () => {
  it("offers only the CLI providers, T3 Code left out", () => {
    expect(preferredChoices(["t3", "codex", "claude-code"])).toEqual(["codex", "claude-code"]);
    expect(preferredChoices(["t3"])).toEqual([]);
  });
});

describe("withT3DefaultRows", () => {
  const tab = (id: string) => ({
    id,
    label: id,
    icon: { kind: "t3code" } as const,
    disabledReason: null,
    notice: null,
    warning: null,
    settingsTarget: null,
    typed: false,
  });
  const row = (tabId: string, key: string) => ({
    key,
    tab: tabId,
    icon: { kind: "t3code" } as const,
    name: key,
    value: key,
    detail: null,
    badge: null,
    isLegacy: false,
    favorite: false,
    disabledReason: null,
    closes: true,
  });

  it("puts a default row first in each provider tab, skipping Favorites, and selects the first when nothing is", () => {
    const model = {
      tabs: [tab("favorites"), tab("anthropic"), tab("openai")],
      rows: [row("anthropic", "a1"), row("openai", "o1")],
      selectedKey: null,
    };
    const next = withT3DefaultRows(model, "Default model");
    expect(next.rows.map((r) => r.key)).toEqual(["t3default:anthropic", "a1", "t3default:openai", "o1"]);
    expect(next.rows[0]).toMatchObject({ name: "Default model", tab: "anthropic", closes: true });
    expect(next.selectedKey).toBe("t3default:anthropic");
    expect(isT3DefaultKey(next.selectedKey!)).toBe(true);
    expect(isT3DefaultKey("a1")).toBe(false);
  });

  it("keeps a saved selection", () => {
    const model = { tabs: [tab("openai")], rows: [row("openai", "o1")], selectedKey: "o1" };
    expect(withT3DefaultRows(model, "Default model").selectedKey).toBe("o1");
  });
});

describe("t3PlaceholderLabel", () => {
  it("says what stands in for the picker", () => {
    expect(t3PlaceholderLabel(false, null, null)).toBe("Not connected");
    expect(t3PlaceholderLabel(false, "boom", "GPT-5.4")).toBe("GPT-5.4");
    expect(t3PlaceholderLabel(true, null, null)).toBe("Loading models…");
    expect(t3PlaceholderLabel(true, null, "GPT-5.4")).toBe("GPT-5.4");
    expect(t3PlaceholderLabel(true, "Catalog failed", "GPT-5.4")).toBe("Catalog failed");
  });
});
