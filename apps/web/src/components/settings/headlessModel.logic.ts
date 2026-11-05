// Pure helpers for the headless model picker: which option a stored choice is, what one saves, and what the choice
// runs. It predates ModelChoice and only offers tiers and a typed Claude Code model; the Models & Operations page
// (#75) replaces it with a picker for every choice.
import {
  CliModel,
  INHERIT,
  MODEL_TIERS,
  modelTierLabel,
  ModelTier,
  profileCliModel,
  tierProfile,
  type ModelChoice,
  type ModelTiers,
} from "@repo/contracts";

/** A stored choice; null and inherit both read as no choice. */
export type HeadlessModel = ModelChoice;

/** "default" is no choice (the CLI's own model), "custom" a typed one, otherwise a tier's id. */
export type HeadlessModelOption = "default" | "custom" | ModelTier;

export interface HeadlessModelItem {
  value: HeadlessModelOption;
  label: string;
}

/**
 * The picker's entries; "no choice" is only offered where it is a valid setting, under the name `defaultLabel` gives
 * what runs then (the CLI default, or what a level above sets).
 */
export function headlessModelItems(allowDefault: boolean, defaultLabel = "CLI default"): HeadlessModelItem[] {
  return [
    ...(allowDefault ? [{ value: "default" as const, label: defaultLabel }] : []),
    ...MODEL_TIERS.map(({ value, label }) => ({ value, label: `${label} tier` })),
    { value: "custom", label: "Custom model" },
  ];
}

/** The option showing for a choice. A typed model being entered (not saved yet) counts as custom. */
export function headlessModelOption(choice: HeadlessModel | null, typing = false): HeadlessModelOption {
  if (typing) return "custom";
  if (!choice || choice === INHERIT) return "default";
  return "tier" in choice ? choice.tier : "custom";
}

/**
 * What picking an option saves. `undefined` saves nothing yet: a custom model has no name until one is typed, so the
 * picker shows the text field and waits.
 */
export function headlessModelForOption(
  option: string,
  current: HeadlessModel | null,
): HeadlessModel | null | undefined {
  if (option === "default") return null;
  if (option === "custom") return current && current !== INHERIT && !("tier" in current) ? current : undefined;
  const tier = ModelTier.safeParse(option);
  return tier.success ? { tier: tier.data } : undefined;
}

/**
 * What a typed model saves, or null when it isn't one `--model` can take (blank, or characters a shell reads). These
 * rows are Claude Code jobs, so a typed model is one for Claude Code.
 */
export function typedHeadlessModel(text: string): HeadlessModel | null {
  const parsed = CliModel.safeParse(text);
  return parsed.success ? { provider: "claude-code", model: parsed.data } : null;
}

/** The text a custom choice shows: a typed model, or a custom model's id. */
export const customModelText = (choice: HeadlessModel | null): string =>
  !choice || choice === INHERIT || "tier" in choice ? "" : "profile" in choice ? choice.profile : choice.model;

/** What the choice runs, to say so under the row. */
export type HeadlessModelRun =
  | { kind: "default" }
  | { kind: "model"; model: string }
  | { kind: "tier"; tier: ModelTier; label: string; model: string }
  /** A tier with no Claude Code model: the run falls back to the CLI's default. */
  | { kind: "tier-unset"; tier: ModelTier; label: string };

export function headlessModelRun(tiers: ModelTiers, choice: HeadlessModel | null): HeadlessModelRun {
  if (!choice || choice === INHERIT) return { kind: "default" };
  if (!("tier" in choice)) return { kind: "model", model: customModelText(choice) };
  const model = profileCliModel(tierProfile(tiers, choice.tier), "claude-code");
  const label = modelTierLabel(choice.tier);
  return model ? { kind: "tier", tier: choice.tier, label, model } : { kind: "tier-unset", tier: choice.tier, label };
}
