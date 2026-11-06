// Pure helpers for Settings → Agents: the Models list (tiers, then custom models), which of its items a settings
// target names, the line under each, and what the T3 Code row shows while its models can't be picked.
import { AgentHarness, MODEL_TIERS, ModelTier, type ModelProfile, type ModelTierSetting } from "@repo/contracts";
import { FAVORITES_TAB, type PickerModel, type PickerRow } from "~/components/models/modelPicker.logic";
import type { TierProvider } from "../modelTiers.logic";

/** One item of the Models list: a tier, or a custom model by id. */
export type ModelItem = { kind: "tier"; tier: ModelTier } | { kind: "custom"; id: string };

export const sameModelItem = (a: ModelItem, b: ModelItem): boolean =>
  a.kind === "tier" ? b.kind === "tier" && a.tier === b.tier : b.kind === "custom" && a.id === b.id;

/** The item a settings target (a link, a search result) names, or null when it names none. */
export function modelItemOfTarget(target: string | null | undefined): ModelItem | null {
  const [group, page, list, ...rest] = (target ?? "").split(".");
  if (group !== "agents" || page !== "models" || rest.length === 0) return null;
  const id = rest.join(".");
  if (list === "tiers") {
    const tier = ModelTier.safeParse(id);
    return tier.success ? { kind: "tier", tier: tier.data } : null;
  }
  return list === "custom" ? { kind: "custom", id } : null;
}

/**
 * The item the detail pane shows: the one picked when it is still there (a custom model can be deleted under it),
 * else the first tier.
 */
export function selectedModelItem(picked: ModelItem | null, profiles: readonly Pick<ModelProfile, "id">[]): ModelItem {
  if (picked?.kind === "tier") return picked;
  if (picked?.kind === "custom" && profiles.some((p) => p.id === picked.id)) return picked;
  return { kind: "tier", tier: MODEL_TIERS[0]!.value };
}

/**
 * The line under an item in the list: the description the user gave it, else the models set on the shown providers
 * (T3 Code's label, a CLI's `--model`), else that every provider runs its default.
 */
export function modelSummary(setting: ModelTierSetting, providers: readonly TierProvider[]): string {
  const description = setting.description?.trim();
  if (description) return description;
  const models = providers
    .map((provider) => (provider === "t3" ? setting.t3?.label : setting.cli?.[provider]?.trim()))
    .filter((model): model is string => !!model);
  return models.length ? models.join(" · ") : "Provider defaults";
}

/**
 * The CLI providers a tier can prefer for headless runs, among those shown. With one or none there is nothing to
 * choose, and the row is left out.
 */
export function preferredChoices(providers: readonly TierProvider[]): AgentHarness[] {
  return providers.filter((provider): provider is AgentHarness => AgentHarness.safeParse(provider).success);
}

const T3_DEFAULT_PREFIX = "t3default:";
export const isT3DefaultKey = (key: string): boolean => key.startsWith(T3_DEFAULT_PREFIX);

/**
 * The T3 picker's model with a "default" row first in each provider's tab, as the CLI pickers have: picking it
 * clears the tier's T3 model, so a thread starts on whatever T3 Code is set to. With nothing saved, the first
 * provider's default row is the selected one; with a saved model the catalog lacks (`saved`), none is.
 */
export function withT3DefaultRows(model: PickerModel, label: string, saved = false): PickerModel {
  const providerTabs = model.tabs.filter((tab) => tab.id !== FAVORITES_TAB);
  const defaults = providerTabs.map((tab): PickerRow => ({
    key: `${T3_DEFAULT_PREFIX}${tab.id}`,
    tab: tab.id,
    icon: { kind: "t3code" },
    name: label,
    value: "",
    detail: "Whatever T3 Code is set to use",
    badge: null,
    isLegacy: false,
    favorite: false,
    disabledReason: null,
    closes: true,
  }));
  const rows = providerTabs.flatMap((tab) => [
    ...defaults.filter((row) => row.tab === tab.id),
    ...model.rows.filter((row) => row.tab === tab.id),
  ]);
  // A saved model T3 Code no longer lists selects nothing: marking the default would say the tier runs it.
  const fallback = saved ? null : (defaults[0]?.key ?? null);
  return { tabs: model.tabs, rows, selectedKey: model.selectedKey ?? fallback };
}

/**
 * What the T3 Code row's control says while its models can't be picked: the catalog's error, else the model saved
 * before, else that it is loading or that T3 Code isn't connected.
 */
export function t3PlaceholderLabel(
  ready: boolean,
  error: string | null,
  savedLabel: string | null | undefined,
): string {
  if (ready && error) return error;
  if (savedLabel) return savedLabel;
  return ready ? "Loading models…" : "Not connected";
}
