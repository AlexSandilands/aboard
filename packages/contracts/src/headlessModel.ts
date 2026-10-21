import { z } from "zod";
import { type CliEffort, ModelTier, type ModelTiers } from "./modelTiers.ts";
import { CliModel, tierCliEffort, tierCliModel } from "./sessionLaunch.ts";

/**
 * The model a headless job (`claude -p`) runs on: one of the Model tiers settings, so it is set once, or a model typed
 * as `--model` takes it. A bare string is the typed model, which is how these settings were saved before tiers were
 * an option.
 */
export const HeadlessModel = z.union([
  z.object({ tier: ModelTier }),
  z.object({ model: CliModel }),
  z
    .string()
    .pipe(CliModel)
    .transform((model) => ({ model })),
]);
export type HeadlessModel = z.output<typeof HeadlessModel>;

/** What a stored value means, or null when it is neither a model nor a tier (a hand-edited database). */
export const parseHeadlessModel = (value: unknown): HeadlessModel | null => {
  const parsed = HeadlessModel.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * The `--model` to pass `claude`, or null for the CLI's own default: a typed model as it is, and a tier's Claude Code
 * model from Settings → Model tiers, which is null while the tier has none.
 */
export const resolveHeadlessModel = (tiers: ModelTiers, choice: HeadlessModel | null): string | null => {
  if (!choice) return null;
  return "tier" in choice ? tierCliModel(tiers, choice.tier, "claude-code") : choice.model;
};

/** The `--effort` to pass `claude` with `resolveHeadlessModel`'s model: a tier's, and none for a typed model. */
export const resolveHeadlessEffort = (tiers: ModelTiers, choice: HeadlessModel | null): CliEffort | null =>
  choice && "tier" in choice ? tierCliEffort(tiers, choice.tier, "claude-code") : null;

export const sameHeadlessModel = (a: HeadlessModel | null, b: HeadlessModel | null): boolean =>
  a === b ||
  (a !== null && b !== null && ("tier" in a ? "tier" in b && a.tier === b.tier : "model" in b && a.model === b.model));
