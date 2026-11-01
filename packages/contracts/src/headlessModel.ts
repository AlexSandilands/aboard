import { z } from "zod";
import { type CliEffort, modelTierDescription, modelTierLabel, ModelTier, type ModelTiers } from "./modelTiers.ts";
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

const CLAUDE_AGENT_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * The short name Claude Code's Agent tool takes for a model (`opus`, `sonnet`, `haiku`, `fable`), read from the
 * model id the user saved ("claude-opus-5-5", "opus[1m]"); null when the id names none of them.
 */
export const claudeAgentAlias = (modelId: string): string | null =>
  CLAUDE_AGENT_ALIASES.find((alias) => modelId.toLowerCase().includes(alias)) ?? null;

/**
 * The line of the review brief that says which model the reviewer subagent runs on, or null while no model is set
 * (the reviewer then runs on the implementer's own). It names the Claude Code way to pick it and leaves other
 * harnesses to do their best.
 */
export const reviewerModelLine = (tiers: ModelTiers, choice: HeadlessModel | null): string | null => {
  if (!choice) return null;
  const claudeModel = resolveHeadlessModel(tiers, choice);
  const subject = (() => {
    if (!("tier" in choice)) return `\`${choice.model}\``;
    const description = modelTierDescription(tiers, choice.tier);
    return `the ${modelTierLabel(choice.tier).toLowerCase()} tier${description ? ` (${description})` : ""}`;
  })();
  const inClaudeCode = claudeModel
    ? `in Claude Code pass \`model: "${claudeAgentAlias(claudeModel) ?? claudeModel}"\` to the Agent tool; elsewhere `
    : "";
  return `Run the reviewer on ${subject}: ${inClaudeCode}pick that model if your harness lets you, else use your own.`;
};
