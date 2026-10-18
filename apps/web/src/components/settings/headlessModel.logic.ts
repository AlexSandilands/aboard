// Pure helpers for the headless model picker: which option a stored choice is, what one saves, and what the choice
// runs.
import {
  CliModel,
  MODEL_TIERS,
  modelTierLabel,
  ModelTier,
  resolveHeadlessModel,
  type HeadlessModel,
  type ModelTiers,
} from "@repo/contracts";

/** "default" is no choice (the CLI's own model), "custom" a typed one, otherwise a tier's id. */
export type HeadlessModelOption = "default" | "custom" | ModelTier;

export interface HeadlessModelItem {
  value: HeadlessModelOption;
  label: string;
}

/** The picker's entries; the CLI default is only offered where "no choice" is a valid setting. */
export function headlessModelItems(allowDefault: boolean): HeadlessModelItem[] {
  return [
    ...(allowDefault ? [{ value: "default" as const, label: "CLI default" }] : []),
    ...MODEL_TIERS.map(({ value, label }) => ({ value, label: `${label} tier` })),
    { value: "custom", label: "Custom model" },
  ];
}

/** The option showing for a choice. A typed model being entered (not saved yet) counts as custom. */
export function headlessModelOption(choice: HeadlessModel | null, typing = false): HeadlessModelOption {
  if (typing) return "custom";
  if (!choice) return "default";
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
  if (option === "custom") return current && "model" in current ? current : undefined;
  const tier = ModelTier.safeParse(option);
  return tier.success ? { tier: tier.data } : undefined;
}

/** What a typed model saves, or null when it isn't one `--model` can take (blank, or characters a shell reads). */
export function typedHeadlessModel(text: string): HeadlessModel | null {
  const parsed = CliModel.safeParse(text);
  return parsed.success ? { model: parsed.data } : null;
}

/** What the choice runs, to say so under the row. */
export type HeadlessModelRun =
  | { kind: "default" }
  | { kind: "model"; model: string }
  | { kind: "tier"; tier: ModelTier; label: string; model: string }
  /** A tier with no Claude Code model: the run falls back to the CLI's default. */
  | { kind: "tier-unset"; tier: ModelTier; label: string };

export function headlessModelRun(tiers: ModelTiers, choice: HeadlessModel | null): HeadlessModelRun {
  if (!choice) return { kind: "default" };
  const model = resolveHeadlessModel(tiers, choice);
  if (!("tier" in choice)) return { kind: "model", model: choice.model };
  const label = modelTierLabel(choice.tier);
  return model ? { kind: "tier", tier: choice.tier, label, model } : { kind: "tier-unset", tier: choice.tier, label };
}
