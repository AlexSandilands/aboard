import { z } from "zod";
import { AGENT_HARNESSES, AgentHarness } from "./agentSessions.ts";
import { LABEL_MAX_LENGTH, normalizeLabel } from "./labels.ts";
import {
  CliEffort,
  cliEffortFor,
  MODEL_TIERS,
  ModelTier,
  ModelTierSetting,
  modelTierLabel,
  type ModelTiers,
  type SuggestedModel,
} from "./modelTiers.ts";
import { CliModel } from "./sessionLaunch.ts";

// Named models beyond the three tiers, and the one way to say which model something runs on (ModelChoice). Which
// choice applies to an operation, and which provider runs it, is operations.ts. See docs/features/autopilot.md#models.

export const MODEL_PROFILES_MAX = 20;
export const MODEL_PROFILE_NAME_MAX = 60;
/** Most labels one model can be picked by. */
export const MODEL_PROFILE_LABELS_MAX = 10;

/** A profile's id: short, stable, and never one of the tiers' names, which are the built-in profiles' ids. */
export const ModelProfileId = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - and _ only")
  .refine((id) => !ModelTier.safeParse(id).success, "light, standard and deep are the tiers' names");

/**
 * A custom model: a tier's setting (T3 model, CLI models, description) with a name, and the task labels that pick it.
 * A task carrying one of the labels runs on it whatever its suggested tier.
 */
export const ModelProfile = ModelTierSetting.extend({
  id: ModelProfileId,
  name: z.string().trim().min(1).max(MODEL_PROFILE_NAME_MAX),
  labels: z
    .array(z.string().transform(normalizeLabel).pipe(z.string().min(1).max(LABEL_MAX_LENGTH)))
    .max(MODEL_PROFILE_LABELS_MAX)
    .default([])
    .transform((labels) => [...new Set(labels)]),
});
export type ModelProfile = z.output<typeof ModelProfile>;

export const ModelProfiles = z
  .array(ModelProfile)
  .max(MODEL_PROFILES_MAX)
  .refine((profiles) => new Set(profiles.map((p) => p.id)).size === profiles.length, "Two models have the same id");
export type ModelProfiles = z.output<typeof ModelProfiles>;

/**
 * Which model something runs on, the one shape every setting uses (operations, automations, reviewer overrides):
 * - `"inherit"`: no choice here, the next setting down decides (operations.ts has the order);
 * - a tier, or a custom model by id, which the resolver maps to a provider the user has added;
 * - a model typed for one provider, with an optional effort.
 */
export const INHERIT = "inherit";

export const ExplicitModel = z.object({
  provider: AgentHarness,
  model: CliModel,
  effort: CliEffort.optional(),
});
export type ExplicitModel = z.infer<typeof ExplicitModel>;

export const ModelChoice = z.union([
  z.literal(INHERIT),
  z.object({ tier: ModelTier }),
  z.object({ profile: z.string().min(1) }),
  ExplicitModel,
]);
export type ModelChoice = z.infer<typeof ModelChoice>;

/** A stored choice, or null when it is none of the shapes (a hand-edited database). */
export const parseModelChoice = (value: unknown): ModelChoice | null => {
  const parsed = ModelChoice.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * A choice in any shape the board ever saved, for migrations and importing an old automation bundle only: the current
 * shape; `{from: "task"}` (an automation's "From the task") and null as inherit; `{tier}`; and a typed model, bare or
 * as `{model}`, as that model on `typedOn`, the provider it ran on (Claude Code for every setting that took one).
 * Anything else is null.
 */
export function readLegacyModelChoice(value: unknown, typedOn: AgentHarness = "claude-code"): ModelChoice | null {
  const current = parseModelChoice(value);
  if (current) return current;
  if (value === null || value === undefined) return INHERIT;
  const typed = (model: unknown): ModelChoice | null => {
    const parsed = CliModel.safeParse(model);
    return parsed.success ? { provider: typedOn, model: parsed.data } : null;
  };
  if (typeof value === "string") return value.trim() ? typed(value) : INHERIT;
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.from === "task") return INHERIT;
  if (typeof record.model === "string") return record.model.trim() ? typed(record.model) : INHERIT;
  return null;
}

export const isInherit = (choice: ModelChoice | null | undefined): boolean => !choice || choice === INHERIT;

/** A reviewer override as stored on a project or task: inherit is stored as none. */
export const overrideValue = (choice: ModelChoice | null | undefined): ModelChoice | null =>
  isInherit(choice) ? null : choice!;

export const sameModelChoice = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined): boolean =>
  modelChoiceKey(a ?? INHERIT) === modelChoiceKey(b ?? INHERIT);

/**
 * "inherit", "tier:deep", "profile:codex61" or "model:codex:gpt-5.5:high": a choice as one string, for a `<select>`.
 * A model can't hold a space, so the parts split back cleanly from the left (a model may hold a colon).
 */
export function modelChoiceKey(choice: ModelChoice): string {
  if (choice === INHERIT) return INHERIT;
  if ("tier" in choice) return `tier:${choice.tier}`;
  if ("profile" in choice) return `profile:${choice.profile}`;
  return `model:${choice.provider}:${choice.model}${choice.effort ? ` ${choice.effort}` : ""}`;
}

export function parseModelChoiceKey(key: string): ModelChoice {
  if (key.startsWith("tier:")) {
    const tier = ModelTier.safeParse(key.slice(5));
    if (tier.success) return { tier: tier.data };
  }
  if (key.startsWith("profile:") && key.length > 8) return { profile: key.slice(8) };
  if (key.startsWith("model:")) {
    const [rest = "", effort] = key.slice(6).split(" ");
    const at = rest.indexOf(":");
    const parsed = ExplicitModel.safeParse({
      provider: rest.slice(0, at),
      model: rest.slice(at + 1),
      ...(effort ? { effort } : {}),
    });
    if (at > 0 && parsed.success) return parsed.data;
  }
  return INHERIT;
}

/** A tier or a custom model, as the resolver hands it out. */
export interface RunProfile {
  /** The tier's value for a tier, else the custom model's id. */
  id: string;
  name: string;
  /** Set for the three tiers. */
  tier: ModelTier | null;
  setting: ModelTierSetting;
}

/**
 * Where a model came from, most specific first: a task's or project's reviewer override, the automation's config (or
 * its action's own choice), the board's setting for the operation, the operation's default; then, when all of those
 * inherit, the task's own model (a custom model its label picks, its suggested tier) and last the light tier.
 */
export type RunModelSource = "task" | "project" | "automation" | "board" | "default" | "label" | "tier" | "fallback";

/** The choice that applies, before a provider is picked for it: a tier or custom model, or a typed model. */
export interface RunModel {
  /** The tier or custom model; null for a typed model. */
  profile: RunProfile | null;
  /** The typed model; null for a profile. */
  explicit: ExplicitModel | null;
  source: RunModelSource;
  /** The task label that picked the model, when `source` is "label". */
  label: string | null;
  /** Why a setting was passed over (its custom model was deleted), else null. */
  note: string | null;
}

export interface ModelSettings {
  modelTiers: ModelTiers;
  modelProfiles: readonly ModelProfile[];
}

export const tierProfile = (tiers: ModelTiers, tier: ModelTier): RunProfile => ({
  id: tier,
  name: modelTierLabel(tier),
  tier,
  setting: tiers[tier],
});

export const customProfile = (profile: ModelProfile): RunProfile => ({
  id: profile.id,
  name: profile.name,
  tier: null,
  setting: profile,
});

/** Every model a choice can name: the tiers, then the custom models in their order. */
export const runProfiles = (settings: ModelSettings): RunProfile[] => [
  ...MODEL_TIERS.map((t) => tierProfile(settings.modelTiers, t.value)),
  ...settings.modelProfiles.map(customProfile),
];

/**
 * A task's own model, what `inherit` comes down to for an operation on a task: a custom model one of its labels picks
 * (the first in the user's order when several do), else its suggested tier, else the light tier.
 */
export function resolveTaskModel(
  task: { labels: readonly string[]; suggestedModel: SuggestedModel | null } | null,
  settings: ModelSettings,
  note: string | null = null,
): RunModel {
  const labels = new Set((task?.labels ?? []).map(normalizeLabel));
  for (const profile of settings.modelProfiles) {
    const label = profile.labels.find((l) => labels.has(l));
    if (label) return { profile: customProfile(profile), explicit: null, source: "label", label, note };
  }
  const tier = task?.suggestedModel?.tier;
  if (tier)
    return { profile: tierProfile(settings.modelTiers, tier), explicit: null, source: "tier", label: null, note };
  return { profile: tierProfile(settings.modelTiers, "light"), explicit: null, source: "fallback", label: null, note };
}

/** The `--model` a harness's CLI takes for a profile, or null when it has none set. */
export const profileCliModel = (profile: RunProfile | null, harness: AgentHarness): string | null =>
  profile?.setting.cli?.[harness]?.trim() || null;

/** The effort that goes with a profile's CLI model, or null for the CLI's default. None without a model set, or one the CLI doesn't take. */
export const profileCliEffort = (profile: RunProfile | null, harness: AgentHarness): CliEffort | null =>
  (profileCliModel(profile, harness) && cliEffortFor(harness, profile?.setting.cliEffort?.[harness])) || null;

/** "the Deep tier (Opus, high effort)", "Codex 6.1", "`gpt-5.5` on Codex": a model as a person reads it. */
export function describeChoice(model: Pick<RunModel, "profile" | "explicit">): string | null {
  if (model.explicit) {
    const effort = model.explicit.effort ? `, ${model.explicit.effort} effort` : "";
    return `${model.explicit.model} on ${AGENT_HARNESSES[model.explicit.provider].label}${effort}`;
  }
  const { profile } = model;
  if (!profile) return null;
  const what = profile.tier ? `${profile.name} tier` : profile.name;
  const detail = profile.setting.description?.trim() || profile.setting.t3?.label || null;
  return detail && detail !== profile.name ? `${what} (${detail})` : what;
}

const SOURCE_WORDS: Partial<Record<RunModelSource, string>> = {
  task: "the task's reviewer model",
  project: "the project's reviewer model",
  automation: "the automation's choice",
  board: "the board's setting",
};

/** How a person is told where a model came from: "Codex 6.1, from label codex61". */
export function describeRunModel(model: RunModel): string | null {
  const named = describeChoice(model);
  if (!named) return null;
  if (model.source === "label") return `${named}, from label ${model.label}`;
  const words = SOURCE_WORDS[model.source];
  return words ? `${named}, ${words}` : named;
}
