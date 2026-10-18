import { EMPTY_MODEL_TIERS, type ModelTiers } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { applyTierChange, createTierEdits, visibleTierProviders } from "./modelTiers.logic";

const T3_MODEL = {
  selection: { instanceId: "codex", model: "gpt-5.4", options: [] },
  label: "GPT-5.4",
} as unknown as NonNullable<ModelTiers["light"]["t3"]>;

const tiers = (patch: Partial<ModelTiers> = {}): ModelTiers => ({ ...EMPTY_MODEL_TIERS, ...patch });

describe("visibleTierProviders", () => {
  it("shows nothing before any integration is set up", () => {
    expect(visibleTierProviders(tiers(), { t3Ready: false, cliFound: {} })).toEqual([]);
    expect(visibleTierProviders(tiers(), { t3Ready: false, cliFound: { "claude-code": false } })).toEqual([]);
  });

  it("shows T3 Code when connected and each CLI when found", () => {
    expect(visibleTierProviders(tiers(), { t3Ready: true, cliFound: {} })).toEqual(["t3"]);
    expect(visibleTierProviders(tiers(), { t3Ready: false, cliFound: { "claude-code": true } })).toEqual([
      "claude-code",
    ]);
    expect(
      visibleTierProviders(tiers(), { t3Ready: true, cliFound: { "claude-code": true, "copilot-cli": true } }),
    ).toEqual(["t3", "claude-code", "copilot-cli"]);
  });

  it("keeps a provider with a saved value, so it can still be cleared", () => {
    const saved = tiers({
      standard: { description: null, t3: T3_MODEL, cli: { "copilot-cli": "gpt-5.4", "claude-code": null } },
    });
    expect(visibleTierProviders(saved, { t3Ready: false, cliFound: { "copilot-cli": false } })).toEqual([
      "t3",
      "copilot-cli",
    ]);
  });
});

describe("createTierEdits", () => {
  const cached = tiers().light;

  it("builds a second edit of a tier on the first while it is still saving", () => {
    const edits = createTierEdits();
    const first = edits.compose(cached, "light", { field: "description", value: "Haiku" });
    // The cache hasn't caught up yet, so it still holds the old tier.
    const second = edits.compose(cached, "light", { field: "cli", harness: "claude-code", value: "haiku" });
    expect(first).toEqual({ description: "Haiku", t3: null });
    expect(second).toEqual({ description: "Haiku", t3: null, cli: { "claude-code": "haiku" } });
  });

  it("goes back to the cache once every save of the tier has settled", () => {
    const edits = createTierEdits();
    edits.compose(cached, "light", { field: "description", value: "Haiku" });
    edits.compose(cached, "light", { field: "t3", value: T3_MODEL });
    edits.settle("light");
    // One save is still in flight.
    expect(edits.compose(cached, "light", { field: "description", value: "B" }).t3).toBe(T3_MODEL);
    edits.settle("light");
    edits.settle("light");
    const fresh = { description: "Server", t3: null };
    expect(edits.compose(fresh, "light", { field: "cli", harness: "copilot-cli", value: "x" })).toEqual({
      description: "Server",
      t3: null,
      cli: { "copilot-cli": "x" },
    });
  });

  it("keeps tiers apart, and tolerates a settle with nothing pending", () => {
    const edits = createTierEdits();
    edits.settle("deep");
    edits.compose(cached, "light", { field: "description", value: "Haiku" });
    expect(edits.compose(tiers().deep, "deep", { field: "description", value: "Opus" })).toEqual({
      description: "Opus",
      t3: null,
    });
  });
});

describe("applyTierChange", () => {
  const current = tiers({
    light: { description: "Haiku", t3: T3_MODEL, cli: { "claude-code": "haiku", "copilot-cli": "gpt-5-mini" } },
  });

  it("changes one field and leaves the tier's others as they were", () => {
    const light = current.light;
    expect(applyTierChange(light, { field: "description", value: null })).toEqual({ ...light, description: null });
    expect(applyTierChange(light, { field: "t3", value: null })).toEqual({ ...light, t3: null });
  });

  it("changes one CLI's model and keeps the other's", () => {
    const next = applyTierChange(current.light, { field: "cli", harness: "claude-code", value: "sonnet" });
    expect(next.cli).toEqual({ "claude-code": "sonnet", "copilot-cli": "gpt-5-mini" });
    expect(next.description).toBe("Haiku");
    const cleared = applyTierChange(current.light, { field: "cli", harness: "copilot-cli", value: null });
    expect(cleared.cli).toEqual({ "claude-code": "haiku", "copilot-cli": null });
  });

  it("adds a CLI model to a tier saved before they existed", () => {
    const next = applyTierChange({ description: null, t3: null }, { field: "cli", harness: "claude-code", value: "x" });
    expect(next).toEqual({ description: null, t3: null, cli: { "claude-code": "x" } });
  });
});
