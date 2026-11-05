// Pure helpers for design A of Settings → Agents (task #97): which provider tab the Tiers card shows, keyboard moves
// along the tabs, and what a folded custom model lists.
import type { ModelTierSetting, ProviderId } from "@repo/contracts";
import type { TierProvider } from "../../modelTiers.logic";

/** A provider's id as the tier settings name it: T3 Code is "t3" there. */
export const tierProviderOf = (id: ProviderId): TierProvider => (id === "t3-code" ? "t3" : id);

/** The tab to show: the one asked for while it is still shown, else the first; null with none to show. */
export function activeTab(shown: readonly TierProvider[], requested: TierProvider | null): TierProvider | null {
  return requested && shown.includes(requested) ? requested : (shown[0] ?? null);
}

/** The tab a key moves to from `current` (arrows wrap; Home and End jump), or null for any other key. */
export function tabForKey(shown: readonly TierProvider[], current: TierProvider, key: string): TierProvider | null {
  const index = shown.indexOf(current);
  if (index < 0 || shown.length === 0) return null;
  switch (key) {
    case "ArrowRight":
      return shown[(index + 1) % shown.length]!;
    case "ArrowLeft":
      return shown[(index - 1 + shown.length) % shown.length]!;
    case "Home":
      return shown[0]!;
    case "End":
      return shown.at(-1)!;
    default:
      return null;
  }
}

/**
 * Whether the Preferred marks show: they pick among the CLIs headless runs can use, so with fewer than two shown
 * there is nothing to choose (the one there is runs them).
 */
export const showsPreferred = (shown: readonly TierProvider[]): boolean => shown.filter((p) => p !== "t3").length > 1;

/** One provider's saved model on a tier or custom model, or null when it starts on the provider's default. */
export function savedModel(setting: ModelTierSetting, provider: TierProvider): string | null {
  if (provider === "t3") return setting.t3?.label ?? null;
  return setting.cli?.[provider]?.trim() || null;
}

/** What a folded custom model's row lists: each shown provider with a model of its own, in tab order. */
export function modelsSet(
  setting: ModelTierSetting,
  shown: readonly TierProvider[],
): Array<{ provider: TierProvider; model: string }> {
  return shown.flatMap((provider) => {
    const model = savedModel(setting, provider);
    return model ? [{ provider, model }] : [];
  });
}
