// Pure helpers for the Model tiers page: which providers' fields a tier row shows, and the settings update one edit
// sends.
import type { AgentHarness, AppSettings, ModelTier, ModelTierSetting, ModelTiers } from "@repo/contracts";

export type TierProvider = "t3" | AgentHarness;

/** What the page knows about each provider: whether it is connected or found right now. */
export interface TierProviderState {
  /** T3 Code: a token is saved and the app is detected, so its model catalog can be read. */
  t3Ready: boolean;
  /** Whether each CLI check found a working CLI; undefined until the check has answered. */
  cliFound: Partial<Record<AgentHarness, boolean>>;
}

export const TIER_PROVIDERS: ReadonlyArray<{ provider: TierProvider; label: string }> = [
  { provider: "t3", label: "T3 Code" },
  { provider: "claude-code", label: "Claude Code" },
  { provider: "copilot-cli", label: "Copilot CLI" },
];

/** Whether any tier already has a value saved for the provider. */
export function hasSavedTierValue(tiers: ModelTiers, provider: TierProvider): boolean {
  return Object.values(tiers).some((tier) => (provider === "t3" ? tier.t3 !== null : !!tier.cli?.[provider]));
}

/**
 * The providers whose fields the page shows: those that are set up or detected (T3 Code connected, a CLI found), and
 * any with a value already saved, so a value can still be seen and cleared when its integration has gone away.
 */
export function visibleTierProviders(tiers: ModelTiers, state: TierProviderState): TierProvider[] {
  return TIER_PROVIDERS.map(({ provider }) => provider).filter((provider) => {
    const ready = provider === "t3" ? state.t3Ready : state.cliFound[provider] === true;
    return ready || hasSavedTierValue(tiers, provider);
  });
}

/** One edit to a tier: the description, T3 Code's model, or the `--model` of one CLI. */
export type TierChange =
  | { field: "description"; value: string | null }
  | { field: "t3"; value: ModelTierSetting["t3"] }
  | { field: "cli"; harness: AgentHarness; value: string | null };

/** The tier with the change applied, leaving every other field (and the other CLI's model) as it was. */
export function applyTierChange(current: ModelTierSetting, change: TierChange): ModelTierSetting {
  switch (change.field) {
    case "description":
      return { ...current, description: change.value };
    case "t3":
      return { ...current, t3: change.value };
    case "cli":
      return { ...current, cli: { ...current.cli, [change.harness]: change.value } };
  }
}

/** The settings update for an edit. Only this tier is sent, so quick edits to two tiers can't overwrite each other. */
export function tierUpdate(
  settings: Pick<AppSettings, "modelTiers">,
  tier: ModelTier,
  change: TierChange,
): { modelTiers: Partial<ModelTiers> } {
  return { modelTiers: { [tier]: applyTierChange(settings.modelTiers[tier], change) } };
}
