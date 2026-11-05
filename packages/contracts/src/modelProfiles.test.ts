import { describe, expect, it } from "vitest";
import { suggestedModelLine } from "./handoff.ts";
import {
  customProfile,
  describeRunModel,
  type ModelChoice,
  modelChoiceKey,
  ModelProfile,
  ModelProfiles,
  overrideValue,
  parseModelChoice,
  parseModelChoiceKey,
  profileCliEffort,
  profileCliModel,
  readLegacyModelChoice,
  resolveTaskModel,
  sameModelChoice,
  type ModelSettings,
} from "./modelProfiles.ts";
import { EMPTY_MODEL_TIERS } from "./modelTiers.ts";

const codex = ModelProfile.parse({
  id: "codex61",
  name: "Codex 6.1",
  labels: ["Codex61", "#fast lane"],
  description: null,
  t3: { selection: { instanceId: "codex", model: "sol-6.1", options: [] }, label: "Codex · Sol 6.1" },
});
const sonnet = ModelProfile.parse({
  id: "sonnet",
  name: "Sonnet",
  labels: ["fast-lane"],
  description: "Sonnet, medium effort",
  t3: null,
  cli: { "claude-code": "sonnet" },
});
const deep = { tier: "deep" as const, reason: null };
const settings: ModelSettings = {
  modelTiers: { ...EMPTY_MODEL_TIERS, deep: { description: "Opus", t3: null, cli: { "claude-code": "opus" } } },
  modelProfiles: [codex, sonnet],
};

describe("model profiles", () => {
  it("normalises labels like task labels and refuses a tier's name as an id", () => {
    expect(codex.labels).toEqual(["codex61", "fast-lane"]);
    expect(ModelProfile.safeParse({ ...codex, id: "deep" }).success).toBe(false);
    expect(ModelProfiles.safeParse([codex, codex]).success).toBe(false);
  });

  it("resolves a task's own model: a label, then its tier, then the light tier", () => {
    expect(resolveTaskModel({ labels: ["ui", "codex61"], suggestedModel: deep }, settings)).toMatchObject({
      source: "label",
      label: "codex61",
      profile: { id: "codex61" },
    });
    expect(resolveTaskModel({ labels: ["ui"], suggestedModel: deep }, settings)).toMatchObject({
      source: "tier",
      profile: { id: "deep" },
    });
    expect(resolveTaskModel({ labels: [], suggestedModel: null }, settings)).toMatchObject({
      source: "fallback",
      profile: { id: "light" },
      explicit: null,
    });
    expect(resolveTaskModel(null, settings).source).toBe("fallback");
  });

  it("gives a label several models claim to the first in the list", () => {
    expect(resolveTaskModel({ labels: ["fast-lane"], suggestedModel: null }, settings).profile?.id).toBe("codex61");
    const swapped = { ...settings, modelProfiles: [sonnet, codex] };
    expect(resolveTaskModel({ labels: ["Fast Lane"], suggestedModel: null }, swapped).profile?.id).toBe("sonnet");
  });

  it("describes a model and where it came from", () => {
    const label = resolveTaskModel(
      { labels: ["fast-lane"], suggestedModel: null },
      { ...settings, modelProfiles: [sonnet] },
    );
    expect(profileCliModel(label.profile, "claude-code")).toBe("sonnet");
    expect(describeRunModel(label)).toBe("Sonnet (Sonnet, medium effort), from label fast-lane");
    expect(describeRunModel(resolveTaskModel({ labels: [], suggestedModel: deep }, settings))).toBe("Deep tier (Opus)");
    expect(
      describeRunModel({
        profile: null,
        explicit: { provider: "codex", model: "gpt-5.5", effort: "high" },
        source: "board",
        label: null,
        note: null,
      }),
    ).toBe("gpt-5.5 on Codex, high effort, the board's setting");
  });

  it("carries a model's effort only while its CLI model is set", () => {
    const high = ModelProfile.parse({
      id: "hi",
      name: "Hi",
      description: null,
      t3: null,
      cli: { "claude-code": "opus" },
      cliEffort: { "claude-code": "high", "copilot-cli": "low" },
    });
    const profile = customProfile(high);
    expect(profileCliEffort(profile, "claude-code")).toBe("high");
    expect(profileCliEffort(profile, "copilot-cli")).toBeNull();
    expect(profileCliEffort(null, "claude-code")).toBeNull();
  });

  it("parses every shape of choice, and nothing else", () => {
    const choices: ModelChoice[] = [
      "inherit",
      { tier: "standard" },
      { profile: "codex61" },
      { provider: "codex", model: "gpt-5.5" },
      { provider: "claude-code", model: "claude-opus-5-5[1m]", effort: "max" },
    ];
    for (const choice of choices) expect(parseModelChoice(choice)).toEqual(choice);
    for (const bad of [
      { from: "task" },
      { model: "haiku" },
      "haiku",
      { tier: "huge" },
      { provider: "t3-code", model: "x" },
    ]) {
      expect(parseModelChoice(bad)).toBeNull();
    }
    expect(parseModelChoice({ provider: "codex", model: "rm -rf" })).toBeNull();
  });

  it("reads every shape the board ever saved, for migrations and old bundles", () => {
    expect(readLegacyModelChoice({ from: "task" })).toBe("inherit");
    expect(readLegacyModelChoice(null)).toBe("inherit");
    expect(readLegacyModelChoice(undefined)).toBe("inherit");
    expect(readLegacyModelChoice("")).toBe("inherit");
    expect(readLegacyModelChoice({ tier: "deep" })).toEqual({ tier: "deep" });
    expect(readLegacyModelChoice("haiku")).toEqual({ provider: "claude-code", model: "haiku" });
    expect(readLegacyModelChoice({ model: "haiku" })).toEqual({ provider: "claude-code", model: "haiku" });
    expect(readLegacyModelChoice("gpt-5.5", "codex")).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(readLegacyModelChoice({ profile: "codex61" })).toEqual({ profile: "codex61" });
    expect(readLegacyModelChoice("not a model")).toBeNull();
    expect(readLegacyModelChoice(42)).toBeNull();
  });

  it("stores inherit as no override, and compares choices by value", () => {
    expect(overrideValue("inherit")).toBeNull();
    expect(overrideValue(null)).toBeNull();
    expect(overrideValue({ tier: "deep" })).toEqual({ tier: "deep" });
    expect(sameModelChoice(null, "inherit")).toBe(true);
    expect(sameModelChoice({ provider: "codex", model: "a" }, { provider: "codex", model: "a" })).toBe(true);
    expect(sameModelChoice({ provider: "codex", model: "a" }, { provider: "claude-code", model: "a" })).toBe(false);
  });

  it("round-trips a choice through its select key", () => {
    const choices: ModelChoice[] = [
      "inherit",
      { tier: "standard" },
      { profile: "codex61" },
      { provider: "codex", model: "gpt-5.5" },
      { provider: "claude-code", model: "claude-opus-5-5[1m]", effort: "max" },
      { provider: "copilot-cli", model: "anthropic/claude:sonnet" },
    ];
    for (const choice of choices) expect(parseModelChoiceKey(modelChoiceKey(choice))).toEqual(choice);
    expect(parseModelChoiceKey("tier:huge")).toBe("inherit");
    expect(parseModelChoiceKey("model:nope:x")).toBe("inherit");
  });

  it("names a label-picked model in a copied work prompt", () => {
    const line = suggestedModelLine(
      { labels: ["codex61"], suggestedModel: { tier: "deep", reason: null } },
      settings.modelTiers,
      undefined,
      settings.modelProfiles,
    );
    expect(line).toBe(
      "Model: Codex 6.1 (Codex · Sol 6.1), picked by the task's label codex61. Switch your session's model if it differs.",
    );
    expect(
      suggestedModelLine({ labels: [], suggestedModel: { tier: "deep", reason: null } }, settings.modelTiers),
    ).toBe("Suggested model: deep (Opus). Switch your session's model if it differs.");
  });
});
