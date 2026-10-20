import { describe, expect, it } from "vitest";
import { suggestedModelLine } from "./handoff.ts";
import {
  describeRunModel,
  type ModelChoice,
  modelChoiceKey,
  ModelProfile,
  ModelProfiles,
  parseModelChoiceKey,
  profileHeadlessModel,
  resolveRunModel,
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

  it("resolves the automation's choice, then a label, then the tier, then the default", () => {
    const task = { labels: ["ui", "codex61"], tier: "deep" as const };
    expect(resolveRunModel({ ...task, choice: { tier: "light" } }, settings)).toMatchObject({
      source: "automation",
      profile: { id: "light", tier: "light" },
    });
    expect(resolveRunModel({ ...task, choice: { profile: "sonnet" } }, settings)).toMatchObject({
      source: "automation",
      profile: { id: "sonnet" },
    });
    expect(resolveRunModel({ ...task, choice: { from: "task" } }, settings)).toMatchObject({
      source: "label",
      label: "codex61",
      profile: { id: "codex61" },
    });
    expect(resolveRunModel({ labels: ["ui"], tier: "deep" }, settings)).toMatchObject({
      source: "tier",
      profile: { id: "deep" },
    });
    expect(resolveRunModel({ labels: [], tier: null }, settings)).toEqual({
      profile: null,
      source: "default",
      label: null,
      note: null,
    });
  });

  it("gives a label several models claim to the first in the list", () => {
    expect(resolveRunModel({ labels: ["fast-lane"], tier: null }, settings).profile?.id).toBe("codex61");
    const swapped = { ...settings, modelProfiles: [sonnet, codex] };
    expect(resolveRunModel({ labels: ["Fast Lane"], tier: null }, swapped).profile?.id).toBe("sonnet");
  });

  it("falls back to the task's model, with a note, when the automation's model was deleted", () => {
    const model = resolveRunModel({ labels: [], tier: "deep", choice: { profile: "gone" } }, settings);
    expect(model).toMatchObject({ source: "tier", profile: { id: "deep" } });
    expect(model.note).toContain('"gone" no longer exists');
  });

  it("picks the headless model and describes where it came from", () => {
    const label = resolveRunModel({ labels: ["fast-lane"], tier: null }, { ...settings, modelProfiles: [sonnet] });
    expect(profileHeadlessModel(label.profile)).toBe("sonnet");
    expect(describeRunModel(label)).toBe("Sonnet (Sonnet, medium effort), from label fast-lane");
    const t3Only = resolveRunModel({ labels: ["codex61"], tier: null }, settings);
    expect(profileHeadlessModel(t3Only.profile)).toBeNull();
    const tier = resolveRunModel({ labels: [], tier: "deep" }, settings);
    expect(describeRunModel(tier)).toBe("Deep tier (Opus)");
  });

  it("round-trips a choice through its select key", () => {
    const choices: ModelChoice[] = [{ from: "task" }, { tier: "standard" }, { profile: "codex61" }];
    for (const choice of choices) expect(parseModelChoiceKey(modelChoiceKey(choice))).toEqual(choice);
    expect(parseModelChoiceKey("tier:huge")).toEqual({ from: "task" });
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
