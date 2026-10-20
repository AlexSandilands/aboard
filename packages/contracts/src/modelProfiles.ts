import { z } from "zod";
import type { AgentHarness } from "./agentSessions.ts";
import { LABEL_MAX_LENGTH, normalizeLabel } from "./labels.ts";
import {
  type CliEffort,
  cliEffortFor,
  MODEL_TIERS,
  ModelTier,
  ModelTierSetting,
  modelTierLabel,
  type ModelTiers,
  type SuggestedModel,
} from "./modelTiers.ts";

// Named models beyond the three tiers, and the one rule that picks the model a run or a session starts on. See
// docs/features/autopilot.md#models.

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
 * Which model an automation runs on: the task's (its labels, else its suggested tier), a tier, or a custom model by
 * id. Saved in an automation's config.
 */
export const ModelChoice = z.union([
  z.object({ from: z.literal("task") }),
  z.object({ tier: ModelTier }),
  z.object({ profile: z.string().min(1) }),
]);
export type ModelChoice = z.infer<typeof ModelChoice>;

export const FROM_TASK: ModelChoice = { from: "task" };

/** "task", "tier:deep" or "profile:codex61": a choice as one string, for a `<select>`. */
export const modelChoiceKey = (choice: ModelChoice): string =>
  "tier" in choice ? `tier:${choice.tier}` : "profile" in choice ? `profile:${choice.profile}` : "task";

export function parseModelChoiceKey(key: string): ModelChoice {
  if (key.startsWith("tier:")) {
    const tier = ModelTier.safeParse(key.slice(5));
    if (tier.success) return { tier: tier.data };
  }
  if (key.startsWith("profile:") && key.length > 8) return { profile: key.slice(8) };
  return FROM_TASK;
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

/** Where a run's model came from, in resolution order. */
export type RunModelSource = "automation" | "label" | "tier" | "default";

export interface RunModel {
  /** Null runs the harness's own default. */
  profile: RunProfile | null;
  source: RunModelSource;
  /** The task label that picked the model, when `source` is "label". */
  label: string | null;
  /** Why an automation's choice was passed over (its custom model was deleted), else null. */
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

const customProfile = (profile: ModelProfile): RunProfile => ({
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
 * The model a run or a session starts on:
 * 1. the automation's explicit choice;
 * 2. a custom model one of the task's labels picks (the first in the user's order when several do);
 * 3. the task's suggested tier;
 * 4. the harness's default.
 */
export function resolveRunModel(
  input: {
    labels?: readonly string[] | undefined;
    tier: ModelTier | null | undefined;
    choice?: ModelChoice | null | undefined;
  },
  settings: ModelSettings,
): RunModel {
  let note: string | null = null;
  const choice = input.choice;
  if (choice && "tier" in choice) {
    return { profile: tierProfile(settings.modelTiers, choice.tier), source: "automation", label: null, note };
  }
  if (choice && "profile" in choice) {
    const profile = settings.modelProfiles.find((p) => p.id === choice.profile);
    if (profile) return { profile: customProfile(profile), source: "automation", label: null, note };
    note = `The automation's model "${choice.profile}" no longer exists in Settings → Model tiers, so the task's was used.`;
  }
  const labels = new Set((input.labels ?? []).map(normalizeLabel));
  for (const profile of settings.modelProfiles) {
    const label = profile.labels.find((l) => labels.has(l));
    if (label) return { profile: customProfile(profile), source: "label", label, note };
  }
  if (input.tier) {
    return { profile: tierProfile(settings.modelTiers, input.tier), source: "tier", label: null, note };
  }
  return { profile: null, source: "default", label: null, note };
}

/** The same for a task: its labels and suggested tier, with no automation choosing. */
export const resolveTaskModel = (
  task: { labels: readonly string[]; suggestedModel: SuggestedModel | null },
  settings: ModelSettings,
): RunModel => resolveRunModel({ labels: task.labels, tier: task.suggestedModel?.tier ?? null }, settings);

/** The `--model` a harness's CLI takes for a profile, or null when it has none set. */
export const profileCliModel = (profile: RunProfile | null, harness: AgentHarness): string | null =>
  profile?.setting.cli?.[harness]?.trim() || null;

/** The effort that goes with a profile's CLI model, or null for the CLI's default. None without a model set, or one the CLI doesn't take. */
export const profileCliEffort = (profile: RunProfile | null, harness: AgentHarness): CliEffort | null =>
  (profileCliModel(profile, harness) && cliEffortFor(harness, profile?.setting.cliEffort?.[harness])) || null;

/**
 * The `--model` a headless `claude -p` run takes for a profile: its Claude Code model, else its T3 model when that is a
 * Claude model `claude` accepts, else null for the CLI's default. Its effort is `profileCliEffort`, which only goes with
 * the Claude Code model.
 */
export function profileHeadlessModel(profile: RunProfile | null): string | null {
  const cli = profileCliModel(profile, "claude-code");
  if (cli) return cli;
  const t3 = profile?.setting.t3?.selection.model;
  return t3 && isClaudeModel(t3) ? t3 : null;
}

/** Whether `claude --model` takes a model: an id (`claude-…`) or one of its aliases. */
export const isClaudeModel = (model: string): boolean => /^(claude-|opus|sonnet|haiku)/i.test(model);

/** The harness and `--model` a headless Autopilot run takes. */
export interface HeadlessRunModel {
  harness: AgentHarness;
  /** Null runs the CLI's default. */
  model: string | null;
}

/**
 * What a headless run on a profile runs: the harness the profile names (Claude Code when it names none, or there is no
 * profile) and that harness's model. Claude Code also takes the profile's T3 model when it is a Claude model.
 */
export function profileHeadless(profile: RunProfile | null): HeadlessRunModel {
  const harness = profile?.setting.headless ?? "claude-code";
  return {
    harness,
    model: harness === "claude-code" ? profileHeadlessModel(profile) : profileCliModel(profile, harness),
  };
}

/** How a person is told where a model came from: "Codex 6.1 (from label codex61)". */
export function describeRunModel(model: RunModel): string | null {
  const { profile } = model;
  if (!profile) return null;
  const what = profile.tier ? `${profile.name} tier` : profile.name;
  const detail = profile.setting.description?.trim() || profile.setting.t3?.label || null;
  const named = detail && detail !== profile.name ? `${what} (${detail})` : what;
  switch (model.source) {
    case "label":
      return `${named}, from label ${model.label}`;
    case "automation":
      return `${named}, the automation's choice`;
    default:
      return named;
  }
}
