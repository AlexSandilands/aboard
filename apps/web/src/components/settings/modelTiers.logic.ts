// Pure helpers for the Model tiers page: which providers' fields a tier row shows, and the tier one edit sends.
import {
  AgentHarness,
  type CliEffort,
  type ModelTier,
  type ModelTierSetting,
  type ModelTiers,
  type ProviderSetting,
} from "@repo/contracts";

export type TierProvider = "t3" | AgentHarness;

/** Which providers the user added and switched on in Settings → Providers. */
export type TierProviderState = Partial<Record<TierProvider, boolean>>;

export const TIER_PROVIDERS: ReadonlyArray<{ provider: TierProvider; label: string }> = [
  { provider: "t3", label: "T3 Code" },
  { provider: "claude-code", label: "Claude Code" },
  { provider: "codex", label: "Codex" },
  { provider: "copilot-cli", label: "Copilot CLI" },
];

/**
 * The providers whose fields the page shows: those added and switched on. A provider that isn't shows nowhere but
 * Settings → Providers, where adding it back brings its saved values back into view.
 */
export function visibleTierProviders(active: TierProviderState): TierProvider[] {
  return TIER_PROVIDERS.map(({ provider }) => provider).filter((provider) => active[provider] === true);
}

/**
 * What the Headless runs select offers: the harnesses added and on, plus the one saved (Claude Code when none is), so
 * the select never shows a value it doesn't list.
 */
export function headlessHarnesses(shown: ReadonlySet<TierProvider>, value: AgentHarness | undefined): AgentHarness[] {
  const current = value ?? "claude-code";
  return AgentHarness.options.filter((harness) => shown.has(harness) || harness === current);
}

/** Settings' providers as the page's state: T3 Code's id is "t3" here. */
export const tierProviderState = (providers: readonly ProviderSetting[]): TierProviderState =>
  Object.fromEntries(providers.filter((p) => p.enabled).map((p) => [p.id === "t3-code" ? "t3" : p.id, true]));

/** One edit to a tier: the description, T3 Code's model, the `--model` or effort of one CLI, or its headless harness. */
export type TierChange =
  | { field: "description"; value: string | null }
  | { field: "t3"; value: ModelTierSetting["t3"] }
  | {
      field: "cli";
      harness: AgentHarness;
      value: string | null;
      /** The efforts the new model takes, when known: the tier's effort is dropped if it isn't one of them. */
      levels?: readonly CliEffort[];
    }
  | { field: "cliEffort"; harness: AgentHarness; value: CliEffort | null }
  /** The harness headless Autopilot runs use; Claude Code is stored as no choice. */
  | { field: "headless"; value: AgentHarness };

/** The efforts without the harness's: null clears it, and nothing is left behind as an empty record. */
function withEffort(
  efforts: ModelTierSetting["cliEffort"],
  harness: AgentHarness,
  value: CliEffort | null,
): ModelTierSetting["cliEffort"] {
  const { [harness]: _old, ...others } = efforts ?? {};
  const next = value ? { ...others, [harness]: value } : others;
  return Object.keys(next).length ? next : undefined;
}

/** The tier with the change applied, leaving every other field (and the other CLI's model) as it was. */
export function applyTierChange(current: ModelTierSetting, change: TierChange): ModelTierSetting {
  switch (change.field) {
    case "description":
      return { ...current, description: change.value };
    case "t3":
      return { ...current, t3: change.value };
    case "cli": {
      const next = { ...current, cli: { ...current.cli, [change.harness]: change.value } };
      // Clearing the model leaves its effort nothing to go with, and a model may not take the one the last did.
      const effort = current.cliEffort?.[change.harness];
      const keep = !!change.value?.trim() && (!effort || !change.levels || change.levels.includes(effort));
      if (keep) return next;
      const { cliEffort: _cliEffort, ...rest } = next;
      const cliEffort = withEffort(current.cliEffort, change.harness, null);
      return cliEffort ? { ...rest, cliEffort } : rest;
    }
    case "cliEffort": {
      const { cliEffort: _cliEffort, ...rest } = current;
      const cliEffort = withEffort(current.cliEffort, change.harness, change.value);
      return cliEffort ? { ...rest, cliEffort } : rest;
    }
    case "headless":
      // The preferred provider; picking one stores it, Claude Code included, since unset no longer means Claude Code.
      return { ...current, provider: change.value };
  }
}

/**
 * Builds the tier each edit sends. The server replaces a whole tier, and the cached settings only catch up once it
 * replies, so a second edit within the same tier (Tab from the description into a model field) would start from the
 * old tier and revert the first. A tier with a save in flight builds on the last one sent instead; once none is, the
 * cache is current again. Only the edited tier is sent, so edits to two tiers can't overwrite each other either.
 */
export function createTierEdits() {
  const pending = new Map<ModelTier, { value: ModelTierSetting; inflight: number }>();
  return {
    /** The tier with `change` applied, to send now. Call `settle` when that save finishes, either way. */
    compose(cached: ModelTierSetting, tier: ModelTier, change: TierChange): ModelTierSetting {
      const entry = pending.get(tier);
      const value = applyTierChange(entry?.value ?? cached, change);
      pending.set(tier, { value, inflight: (entry?.inflight ?? 0) + 1 });
      return value;
    },
    settle(tier: ModelTier): void {
      const entry = pending.get(tier);
      if (!entry) return;
      if (entry.inflight <= 1) pending.delete(tier);
      else entry.inflight -= 1;
    },
  };
}

export type TierEdits = ReturnType<typeof createTierEdits>;

/**
 * Saves one edit: sends only its tier, built on any save of that tier still in flight, and settles the tier when the
 * save ends either way. Callers get no rejection; whoever owns `send` reports a failure (the settings hook toasts).
 */
export function saveTierChange(
  edits: TierEdits,
  send: (update: { modelTiers: Partial<ModelTiers> }) => Promise<unknown>,
  cached: ModelTierSetting,
  tier: ModelTier,
  change: TierChange,
): Promise<void> {
  const next = edits.compose(cached, tier, change);
  return send({ modelTiers: { [tier]: next } }).then(
    () => edits.settle(tier),
    () => edits.settle(tier),
  );
}
