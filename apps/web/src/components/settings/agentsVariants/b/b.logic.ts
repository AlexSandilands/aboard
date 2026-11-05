// Pure helpers for design B of Settings → Agents: the providers a tier's Preferred select offers, the one-line
// summary of a custom model's models, and what a T3 Code model field says while it can't pick.
import { AGENT_HARNESSES, type AgentHarness, type ModelTierSetting, type ProviderSetting } from "@repo/contracts";
import { effortLabel } from "~/components/handoff/cliEffort.logic";
import { TIER_PROVIDERS, tierProviderState, visibleTierProviders, type TierProvider } from "../../modelTiers.logic";

/** The providers added and switched on, in the page's order (T3 Code first). */
export const activeProviders = (providers: readonly ProviderSetting[]): TierProvider[] =>
  visibleTierProviders(tierProviderState(providers));

export const providerLabel = (provider: TierProvider): string =>
  TIER_PROVIDERS.find((p) => p.provider === provider)!.label;

export interface PreferredChoice {
  harness: AgentHarness;
  label: string;
  /** Added and switched on; a saved choice that isn't stays listed, marked, so the select still shows it. */
  available: boolean;
}

/**
 * What a tier's Preferred provider select offers: the CLI providers added and switched on (T3 Code can't run headless),
 * plus the saved one when it no longer is, so the select doesn't show an empty value.
 */
export function preferredChoices(
  providers: readonly ProviderSetting[],
  current: AgentHarness | undefined,
): PreferredChoice[] {
  const active = activeProviders(providers).filter((p): p is AgentHarness => p !== "t3");
  const choices: PreferredChoice[] = active.map((harness) => ({
    harness,
    label: AGENT_HARNESSES[harness].label,
    available: true,
  }));
  if (current && !active.includes(current)) {
    const added = providers.some((p) => p.id === current);
    choices.push({
      harness: current,
      label: `${AGENT_HARNESSES[current].label} (${added ? "off" : "not added"})`,
      available: false,
    });
  }
  return choices;
}

/** What one provider runs for a tier or custom model: "gpt-5.4, high", "GPT-5.4" (T3 Code's label) or "default". */
export function providerModelText(setting: ModelTierSetting, provider: TierProvider): string {
  if (provider === "t3") return setting.t3?.label ?? "default";
  const model = setting.cli?.[provider]?.trim();
  if (!model) return "default";
  const effort = setting.cliEffort?.[provider];
  return effort ? `${model}, ${effortLabel(effort).toLowerCase()}` : model;
}

/**
 * One line under a custom model: what each active provider runs for it, the preferred one marked. Empty while no
 * provider is on, so the row says nothing rather than "default" for nobody.
 */
export function modelSummary(setting: ModelTierSetting, shown: readonly TierProvider[]): string {
  return shown
    .map((provider) => {
      const text = `${providerLabel(provider)}: ${providerModelText(setting, provider)}`;
      return setting.provider === provider ? `${text} (preferred)` : text;
    })
    .join(" · ");
}

/**
 * What a T3 Code model field shows while its picker can't open: the catalog's error, else the saved model's label,
 * else that it is loading or that T3 Code isn't connected.
 */
export function t3FieldText(
  ready: boolean,
  catalogError: string | null,
  savedLabel: string | null,
): { text: string; muted: boolean } {
  if (ready && catalogError) return { text: catalogError, muted: true };
  if (savedLabel) return { text: savedLabel, muted: false };
  return { text: ready ? "Loading models…" : "Not connected", muted: true };
}
