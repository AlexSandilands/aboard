// Pure helpers for design C's tier cards: which provider rows a card shows, in what order, and whether each can be set.
import { AgentHarness, PROVIDERS, type ProviderSetting, type ProviderStatus } from "@repo/contracts";
import type { TierProvider } from "../../modelTiers.logic";

export interface CardRow {
  provider: TierProvider;
  label: string;
  /**
   * "ready": its picker works. "offline": T3 Code without a working connection, so there's no catalog to pick from;
   * the row says why and links to the fix.
   */
  state: "ready" | "offline";
  /** Why an offline row can't be set, or a CLI's problem (hover text on its dot); null when all is well. */
  problem: string | null;
  /** The settings target that fixes the problem, or opens the provider. */
  target: string;
}

/** T3 Code's id on the tier rows ("t3") from its provider id, and back. */
const tierProviderOf = (id: ProviderSetting["id"]): TierProvider => (id === "t3-code" ? "t3" : id);

/**
 * One row per provider added and switched on, in the user's Providers order: that order is also the one headless runs
 * fall back on, so the cards read the same way. Switched-off providers show nowhere but Providers.
 */
export function cardRows(
  providers: readonly ProviderSetting[],
  statusOf: (id: ProviderSetting["id"]) => ProviderStatus | undefined,
  t3: { tokenSet: boolean; detected: boolean | undefined },
): CardRow[] {
  return providers
    .filter((p) => p.enabled)
    .map((p) => {
      const provider = tierProviderOf(p.id);
      const label = PROVIDERS[p.id].label;
      if (provider === "t3") {
        const problem = !t3.tokenSet ? "Not connected" : t3.detected === false ? "Not running" : null;
        return {
          provider,
          label,
          state: problem ? "offline" : "ready",
          problem,
          target: !t3.tokenSet ? "agents.providers.t3-code.pairing" : "agents.providers.t3-code.status",
        } satisfies CardRow;
      }
      const cli = statusOf(p.id)?.cli;
      const problem = cli && !cli.found ? "CLI not found" : null;
      return {
        provider,
        label,
        state: "ready",
        problem,
        target: problem ? `agents.providers.${p.id}.cli-path` : `agents.providers.${p.id}`,
      } satisfies CardRow;
    });
}

/** Whether a row can be the tier's preferred provider: only a CLI runs headless. */
export const canPrefer = (provider: TierProvider): provider is AgentHarness => AgentHarness.safeParse(provider).success;
