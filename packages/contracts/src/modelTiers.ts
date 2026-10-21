import { z } from "zod";
import { AgentHarness } from "./agentSessions.ts";
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

/** An effort level as `--effort` (Claude Code) or `--reasoning-effort` (Copilot CLI) takes it: the union of both. */
export const CliEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type CliEffort = z.infer<typeof CliEffort>;

/**
 * The levels each CLI accepts, which a model's own scanned levels narrow. Copilot CLI lists no levels per model, so
 * these apply to all of them.
 */
export const CLI_EFFORTS: Record<AgentHarness, readonly CliEffort[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  // Codex has no effort of its own here: `codex exec` takes none on its command line.
  codex: [],
  "copilot-cli": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/** The level, when the harness's CLI takes it: `none` and `minimal` are Copilot's, and `claude --effort` refuses them. */
export const cliEffortFor = (harness: AgentHarness, effort: CliEffort | null | undefined): CliEffort | null =>
  effort && CLI_EFFORTS[harness].includes(effort) ? effort : null;

/** Each harness's effort for a tier or custom model; a harness with none runs the CLI's default effort. */
export const CliEfforts = z.partialRecord(AgentHarness, CliEffort);
export type CliEfforts = z.infer<typeof CliEfforts>;

/**
 * What one tier means for this user: free text for any harness, plus optional models for T3 Code and for the CLIs
 * the board starts sessions in.
 */
export const ModelTierSetting = z.object({
  /** e.g. "Sonnet 5.5, medium effort"; shown in copied prompts. */
  description: z.string().nullable(),
  /** The label is captured when saved, so prompts can name the model without asking T3. */
  t3: z.object({ selection: T3ModelSelection, label: z.string() }).nullable(),
  /**
   * The `--model` a new Claude Code or Copilot CLI session runs on for this tier. Optional: settings saved before
   * it existed have none. Checked as a CliModel when saved (sessionLaunch.ts imports this file).
   */
  cli: z.partialRecord(AgentHarness, z.string().nullable()).optional(),
  /**
   * The effort a CLI session or headless run on that model starts with. Optional like `cli`; only meaningful while the
   * harness has a model set here.
   */
  cliEffort: CliEfforts.optional(),
  /**
   * The harness a headless Autopilot run on this model uses, with its `cli` model. Unset (and settings saved before it
   * existed) is Claude Code.
   */
  headless: AgentHarness.optional(),
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
