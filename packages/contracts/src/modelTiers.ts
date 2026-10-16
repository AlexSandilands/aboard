import { z } from "zod";
import { T3ModelSelection } from "./t3Launch.ts";

// A task suggests a tier rather than a model, so planning agents never need to know any harness's model
// catalog. The user maps each tier to a model in settings.

export const ModelTier = z.enum(["light", "standard", "deep"]);
export type ModelTier = z.infer<typeof ModelTier>;

export const MODEL_TIERS: ReadonlyArray<{ value: ModelTier; label: string; description: string }> = [
  {
    value: "light",
    label: "Light",
    description:
      "Small, well-specified work with an obvious approach: a copy change, a one-file fix, mechanical edits.",
  },
  {
    value: "standard",
    label: "Standard",
    description: "A typical feature or fix across a few files that follows existing patterns.",
  },
  {
    value: "deep",
    label: "Deep",
    description:
      "Cross-cutting, ambiguous or risky work (architecture, migrations, concurrency, security) that needs careful reasoning.",
  },
];

export const modelTierLabel = (tier: ModelTier): string => MODEL_TIERS.find((t) => t.value === tier)!.label;

export const SUGGESTED_MODEL_REASON_MAX = 300;

/** The model tier a task's planner suggests for implementing it. */
export const SuggestedModel = z.object({ tier: ModelTier, reason: z.string().nullable() });
export type SuggestedModel = z.infer<typeof SuggestedModel>;

export const SuggestedModelInput = z.object({
  tier: ModelTier,
  /** One short sentence on why; blank is stored as none. */
  reason: z.string().trim().max(SUGGESTED_MODEL_REASON_MAX).optional(),
});
export type SuggestedModelInput = z.infer<typeof SuggestedModelInput>;

/** What one tier means for this user: free text for any harness, plus an optional T3 Code model. */
export const ModelTierSetting = z.object({
  /** e.g. "Sonnet 5.5, medium effort"; shown in copied prompts. */
  description: z.string().nullable(),
  /** The label is captured when saved, so prompts can name the model without asking T3. */
  t3: z.object({ selection: T3ModelSelection, label: z.string() }).nullable(),
});
export type ModelTierSetting = z.infer<typeof ModelTierSetting>;

export const ModelTiers = z.object({ light: ModelTierSetting, standard: ModelTierSetting, deep: ModelTierSetting });
export type ModelTiers = z.infer<typeof ModelTiers>;

export const EMPTY_MODEL_TIERS: ModelTiers = {
  light: { description: null, t3: null },
  standard: { description: null, t3: null },
  deep: { description: null, t3: null },
};

/** How a tier is named to a person: its description, else its T3 model, else null. */
export const modelTierDescription = (tiers: ModelTiers, tier: ModelTier): string | null =>
  tiers[tier].description?.trim() || tiers[tier].t3?.label || null;

/** The stored form of an input suggestion: a blank reason becomes null. */
export const toSuggestedModel = (input: SuggestedModelInput | null): SuggestedModel | null =>
  input ? { tier: input.tier, reason: input.reason?.trim() || null } : null;

export const sameSuggestedModel = (a: SuggestedModel | null, b: SuggestedModel | null): boolean =>
  a?.tier === b?.tier && (a?.reason ?? null) === (b?.reason ?? null);
