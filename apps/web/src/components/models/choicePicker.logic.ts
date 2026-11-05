// The shared picker for a ModelChoice (an operation's model, a reviewer override, an automation's Model) and for one
// CLI's model (a tier's cell, the launch dialogs): its tabs and rows, what a pick saves, the effort column, and the
// line saying what a choice resolves to. The resolver is #74's (packages/contracts/src/operations.ts).
import {
  AGENT_HARNESSES,
  AgentHarness,
  CliModel,
  INHERIT,
  MODEL_TIERS,
  ModelTier,
  modelEffortLevels,
  modelTierDescription,
  missingNeeds,
  NEED_WORDS,
  needsWarning,
  OPERATIONS,
  resolveOperationModel,
  type AgentModel,
  type AgentModels,
  type CliEffort,
  type ModelChoice,
  type OperationContext,
  type OperationId,
  type OperationNeed,
  type OperationResolution,
  type OperationSettings,
  type ResolvedModel,
} from "@repo/contracts";
import { effortLabel } from "~/components/handoff/cliEffort.logic";
import {
  CHOICES_TAB,
  type EffortColumnModel,
  type PickerModel,
  type PickerRow,
  type PickerTab,
} from "./modelPicker.logic";

const harnessLabel = (harness: AgentHarness) => AGENT_HARNESSES[harness].label;

const listWords = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

export interface ChoicePickerInput {
  settings: OperationSettings;
  /** What `/api/agent-models` listed; undefined while it loads or where it isn't asked. */
  scanned: AgentModels | undefined;
  /** The saved choice; null reads as inherit. */
  value: ModelChoice | null;
  /** The operation it is for: what its providers must be able to do, and what a tier resolves to for it. */
  op: OperationId | null;
  /** What the run asks beyond the operation's needs. */
  needs?: readonly OperationNeed[];
  /** List inherit, the tiers and the custom models in a tab of their own. */
  choices: boolean;
  /** The inherit row: its name and what it comes down to now. Null leaves inherit out. */
  inherit: { label: string; detail: string | null } | null;
  /**
   * A row for no setting at this level (saved as none, so the level below decides): the board's operation models,
   * where none takes the operation's default while inherit, for an operation on a task, takes the task's own model.
   */
  unset?: { label: string; detail: string | null } | null;
  /** Only this provider's models can be picked. */
  lockedProvider: AgentHarness | null;
  /** Offer the CLI's own default model, under this name, first in each provider's tab. */
  defaultLabel?: string | null;
}

/** What a row saves: inherit, a tier, a custom model, or a provider's model (null for the CLI's default). */
export type PickedChoice =
  | { kind: "unset" }
  | { kind: "inherit" }
  | { kind: "tier"; tier: ModelTier }
  | { kind: "profile"; id: string }
  | { kind: "model"; provider: AgentHarness; model: string | null };

export const modelRowKey = (provider: AgentHarness, model: string) => `model:${provider}:${model}`;
const defaultRowKey = (provider: AgentHarness) => `default:${provider}`;
const typedRowKey = (provider: AgentHarness, model: string) => `typed:${provider}:${model}`;

const UNSET_KEY = "unset";

/** The pick a row's key stands for, or null for a key that isn't a row's (the legacy toggle). */
export function parsePickKey(key: string): PickedChoice | null {
  if (key === UNSET_KEY) return { kind: "unset" };
  if (key === INHERIT) return { kind: "inherit" };
  if (key.startsWith("tier:")) {
    const tier = ModelTier.safeParse(key.slice(5));
    return tier.success ? { kind: "tier", tier: tier.data } : null;
  }
  if (key.startsWith("profile:")) return key.length > 8 ? { kind: "profile", id: key.slice(8) } : null;
  const [kind, provider, ...rest] = key.split(":");
  const harness = AgentHarness.safeParse(provider);
  if (!harness.success) return null;
  if (kind === "default") return { kind: "model", provider: harness.data, model: null };
  if (kind === "model" || kind === "typed") return { kind: "model", provider: harness.data, model: rest.join(":") };
  return null;
}

/**
 * The key of the row a saved choice shows as. With an unset row, none shows as it and inherit as the inherit row;
 * without one, both show as inherit.
 */
export function choiceRowKey(value: ModelChoice | null, hasUnset = false, hasInherit = true): string {
  if (!value) return hasUnset ? UNSET_KEY : INHERIT;
  if (value === INHERIT) return hasInherit || !hasUnset ? INHERIT : UNSET_KEY;
  if ("tier" in value) return `tier:${value.tier}`;
  if ("profile" in value) return `profile:${value.profile}`;
  return modelRowKey(value.provider, value.model);
}

const scannedModels = (scanned: AgentModels | undefined, harness: AgentHarness): readonly AgentModel[] =>
  scanned?.harnesses.find((h) => h.harness === harness)?.models ?? [];

/** The scanned model by id, if the scan listed it. */
export const findScanned = (
  scanned: AgentModels | undefined,
  harness: AgentHarness,
  model: string | null,
): AgentModel | undefined => (model ? scannedModels(scanned, harness).find((m) => m.value === model) : undefined);

/**
 * Why a provider can't be picked here, or null: it isn't added or is switched off in Settings → Providers, or it
 * can't do what the operation needs.
 */
export function providerDisabledReason(
  harness: AgentHarness,
  input: Pick<ChoicePickerInput, "settings" | "op" | "needs" | "lockedProvider">,
): string | null {
  const label = harnessLabel(harness);
  if (input.lockedProvider && input.lockedProvider !== harness) {
    return `Only ${harnessLabel(input.lockedProvider)} models can be picked here.`;
  }
  const setting = input.settings.providers.find((p) => p.id === harness);
  if (!setting) return `${label} isn't added. Add it in Settings → Providers.`;
  if (!setting.enabled) return `${label} is switched off in Settings → Providers.`;
  if (!input.op) return null;
  const needs = [...new Set([...OPERATIONS[input.op].needs, ...(input.needs ?? [])])];
  const missing = missingNeeds(harness, needs);
  return missing.length > 0
    ? `${label} can't ${listWords(missing.map((need) => NEED_WORDS[need]))}, which ${OPERATIONS[input.op].label} needs.`
    : null;
}

/**
 * What could go wrong when a provider that can be picked runs the operation, or null: it meets the operation's needs
 * only with a warning (Codex reading untrusted text). It is never fallen back to, so this only matters when chosen.
 */
export function providerWarning(
  harness: AgentHarness,
  input: Pick<ChoicePickerInput, "settings" | "op" | "needs" | "lockedProvider">,
): string | null {
  if (!input.op || providerDisabledReason(harness, input)) return null;
  const needs = [...new Set([...OPERATIONS[input.op].needs, ...(input.needs ?? [])])];
  const warning = needsWarning(harness, needs);
  return warning ? `${warning} It runs ${OPERATIONS[input.op].label} only when you choose it.` : null;
}

/**
 * The provider tabs: the providers the user added, in their order (switched-off ones greyed out), plus the saved
 * model's provider if it isn't among them, so the selection always has a tab. Locked to a provider, only that one.
 */
function providerTabs(input: ChoicePickerInput): AgentHarness[] {
  if (input.lockedProvider) return [input.lockedProvider];
  const added = input.settings.providers.flatMap((p) => {
    const harness = AgentHarness.safeParse(p.id);
    return harness.success ? [harness.data] : [];
  });
  const saved = input.value && input.value !== INHERIT && "provider" in input.value ? input.value.provider : null;
  return saved && !added.includes(saved) ? [...added, saved] : added;
}

/** "Codex · gpt-5.5 (high)": a resolution as a picker row's detail, or why nothing can run it. */
export function shortResolution(resolution: OperationResolution, taskScopedWithoutTask = false): string {
  if (!resolution.ok) return "Nothing can run it";
  if (taskScopedWithoutTask && isTaskOwnModel(resolution)) return "The task's own model";
  return `${harnessLabel(resolution.provider)} · ${resolution.model ?? "default model"}${resolution.effort ? ` (${resolution.effort})` : ""}${resolution.warning ? ", with a warning" : ""}`;
}

const isTaskOwnModel = (resolution: ResolvedModel) =>
  resolution.source === "label" || resolution.source === "tier" || resolution.source === "fallback";

/** What a tier or custom model comes down to for the operation, run as if this picker chose it. */
function choiceDetail(input: ChoicePickerInput, choice: ModelChoice, fallback: string | null): string | null {
  if (!input.op) return fallback;
  return shortResolution(resolveOperationModel(input.op, { automation: [choice], needs: input.needs }, input.settings));
}

function choiceRows(input: ChoicePickerInput): PickerRow[] {
  const row = (fields: Pick<PickerRow, "key" | "icon" | "name" | "value" | "detail">): PickerRow => ({
    ...fields,
    tab: CHOICES_TAB,
    badge: null,
    isLegacy: false,
    favorite: false,
    disabledReason: null,
    closes: true,
  });
  const rows: PickerRow[] = [];
  if (input.unset) {
    rows.push(
      row({
        key: UNSET_KEY,
        icon: { kind: "inherit" },
        name: input.unset.label,
        value: "",
        detail: input.unset.detail,
      }),
    );
  }
  if (input.inherit) {
    rows.push(
      row({
        key: INHERIT,
        icon: { kind: "inherit" },
        name: input.inherit.label,
        value: "",
        detail: input.inherit.detail,
      }),
    );
  }
  for (const tier of MODEL_TIERS) {
    rows.push(
      row({
        key: `tier:${tier.value}`,
        icon: { kind: "tier" },
        name: `${tier.label} tier`,
        value: "",
        detail: choiceDetail(input, { tier: tier.value }, modelTierDescription(input.settings.modelTiers, tier.value)),
      }),
    );
  }
  for (const profile of input.settings.modelProfiles) {
    rows.push(
      row({
        key: `profile:${profile.id}`,
        icon: { kind: "custom" },
        name: profile.name,
        value: "",
        detail: choiceDetail(input, { profile: profile.id }, profile.description),
      }),
    );
  }
  const saved = input.value;
  if (
    saved &&
    saved !== INHERIT &&
    "profile" in saved &&
    !input.settings.modelProfiles.some((p) => p.id === saved.profile)
  ) {
    rows.push(
      row({
        key: `profile:${saved.profile}`,
        icon: { kind: "custom" },
        name: `${saved.profile} (deleted)`,
        value: "",
        detail: "The next setting decides",
      }),
    );
  }
  return rows;
}

function providerRows(input: ChoicePickerInput, harness: AgentHarness): PickerRow[] {
  const base = {
    tab: harness,
    icon: { kind: "harness", harness } as const,
    badge: null,
    isLegacy: false,
    favorite: false,
  };
  const rows: PickerRow[] = [];
  if (input.defaultLabel) {
    rows.push({
      ...base,
      key: defaultRowKey(harness),
      name: input.defaultLabel,
      value: "",
      detail: `Whatever ${harnessLabel(harness)} is set to use`,
      disabledReason: null,
      closes: true,
    });
  }
  const models = scannedModels(input.scanned, harness);
  for (const model of models) {
    rows.push({
      ...base,
      key: modelRowKey(harness, model.value),
      name: model.label ?? model.value,
      value: model.value,
      detail: model.description,
      disabledReason: null,
      // A model that takes no effort has nothing to set next.
      closes: modelEffortLevels(harness, model).length === 0,
    });
  }
  const saved = input.value;
  if (
    saved &&
    saved !== INHERIT &&
    "provider" in saved &&
    saved.provider === harness &&
    !models.some((m) => m.value === saved.model)
  ) {
    rows.push({
      ...base,
      key: modelRowKey(harness, saved.model),
      name: saved.model,
      value: saved.model,
      detail: "Typed",
      disabledReason: null,
      closes: false,
    });
  }
  return rows;
}

/** The picker's tabs and rows for a ModelChoice or a CLI's model. */
export function choicePickerModel(input: ChoicePickerInput): PickerModel {
  const harnesses = providerTabs(input);
  const tabs: PickerTab[] = [
    ...(input.choices
      ? [
          {
            id: CHOICES_TAB,
            label: "Tiers and custom models",
            icon: { kind: "choices" } as const,
            disabledReason: null,
            notice: null,
            warning: null,
            settingsTarget: "models.tiers",
            typed: false,
          },
        ]
      : []),
    ...harnesses.map((harness): PickerTab => {
      const scan = input.scanned?.harnesses.find((h) => h.harness === harness);
      return {
        id: harness,
        label: harnessLabel(harness),
        icon: { kind: "harness", harness },
        disabledReason: providerDisabledReason(harness, input),
        warning: providerWarning(harness, input),
        notice: scan?.error
          ? `Couldn't list ${harnessLabel(harness)}'s models: ${scan.error}. A model can be typed.`
          : null,
        settingsTarget: `providers.${harness}`,
        // Every CLI takes a model by name, so one the scan doesn't list (or a CLI that isn't scanned) can be typed.
        typed: true,
      };
    }),
  ];
  const rows = [...(input.choices ? choiceRows(input) : []), ...harnesses.flatMap((h) => providerRows(input, h))];
  const value = input.value;
  const selectedKey =
    !input.choices && (!value || value === INHERIT)
      ? input.defaultLabel && harnesses[0]
        ? defaultRowKey(harnesses[0])
        : null
      : choiceRowKey(value, !!input.unset, !!input.inherit);
  return { tabs, rows, selectedKey: rows.some((row) => row.key === selectedKey) ? selectedKey : null };
}

/** What the search offers to use as typed, or why the text can't be a model. */
export interface TypedRows {
  rows: PickerRow[];
  error: string | null;
}

/**
 * The search text as a model of its own, on each provider that takes typed models and can be picked (only the open
 * tab's provider when a provider's tab is open), unless that provider lists exactly that model.
 */
export function typedRows(model: PickerModel, query: string, openTab: string): TypedRows {
  const text = query.trim();
  if (!text) return { rows: [], error: null };
  const tabs = model.tabs.filter(
    (tab) =>
      tab.typed &&
      !tab.disabledReason &&
      (openTab === CHOICES_TAB || !isHarnessTab(model, openTab) || tab.id === openTab),
  );
  if (tabs.length === 0) return { rows: [], error: null };
  if (!CliModel.safeParse(text).success) {
    return { rows: [], error: "A model name has only letters, digits and . : @ / [ ] -" };
  }
  const rows = tabs.flatMap((tab): PickerRow[] => {
    const harness = AgentHarness.parse(tab.id);
    if (model.rows.some((row) => row.tab === tab.id && row.value === text)) return [];
    return [
      {
        key: typedRowKey(harness, text),
        tab: tab.id,
        icon: { kind: "harness", harness },
        name: `Use ${text}`,
        value: text,
        detail: `Passed to ${tab.label} as typed`,
        badge: null,
        isLegacy: false,
        favorite: false,
        disabledReason: null,
        closes: false,
      },
    ];
  });
  return { rows, error: null };
}

const isHarnessTab = (model: PickerModel, id: string) =>
  model.tabs.some((tab) => tab.id === id) && AgentHarness.safeParse(id).success;

/**
 * The choice a pick saves: null for the unset row. A provider's model keeps the saved effort while the new model
 * takes it; the CLI's default model (null) saves inherit, as there is no choice to keep.
 */
export function choiceForPick(
  pick: PickedChoice,
  current: ModelChoice | null,
  scanned: AgentModels | undefined,
): ModelChoice | null {
  switch (pick.kind) {
    case "unset":
      return null;
    case "inherit":
      return INHERIT;
    case "tier":
      return { tier: pick.tier };
    case "profile":
      return { profile: pick.id };
    case "model": {
      if (!pick.model) return INHERIT;
      const effort =
        current && current !== INHERIT && "provider" in current && current.provider === pick.provider
          ? current.effort
          : undefined;
      const keep = effort && modelLevels(scanned, pick.provider, pick.model).includes(effort);
      return { provider: pick.provider, model: pick.model, ...(keep ? { effort } : {}) };
    }
  }
}

/**
 * The levels a provider's model takes: its scanned ones, else the CLI's. None for the CLI's default model (null): an
 * effort goes with a model set here, so picking the default drops it, as it does on the Models page.
 */
export const modelLevels = (
  scanned: AgentModels | undefined,
  provider: AgentHarness,
  model: string | null,
): readonly CliEffort[] => (model ? modelEffortLevels(provider, findScanned(scanned, provider, model)) : []);

/**
 * The effort column beside the list: the selected model's levels, with "Default" for the CLI's own; a level saved
 * that the model no longer lists stays, so it can be seen and changed. A choice that isn't one model sets no effort
 * here, and the column says where it comes from.
 */
export function choiceEffortColumn(
  pick: PickedChoice | null,
  effort: CliEffort | null,
  scanned: AgentModels | undefined,
  modelLabel: string,
): EffortColumnModel {
  const empty = (note: string): EffortColumnModel => ({ modelLabel, groups: [], toggles: [], note });
  if (!pick) return empty("Pick a model to set its effort.");
  if (pick.kind === "inherit" || pick.kind === "unset") return empty("The setting it comes down to sets the effort.");
  if (pick.kind !== "model") return empty("A tier or custom model sets its own effort on the Models page.");
  if (!pick.model) return empty(`${harnessLabel(pick.provider)}'s default model runs at its default effort.`);
  const levels = modelLevels(scanned, pick.provider, pick.model);
  if (levels.length === 0) return empty("This model takes no effort.");
  const shown = effort && !levels.includes(effort) ? [effort, ...levels] : levels;
  return {
    modelLabel,
    groups: [
      {
        id: "effort",
        label: "Effort",
        options: [{ id: null, label: "Default" }, ...shown.map((level) => ({ id: level, label: effortLabel(level) }))],
        value: effort,
      },
    ],
    toggles: [],
    note: null,
  };
}

// ── What a choice resolves to ────────────────────────────────────────────

const SOURCE_WORDS: Record<ResolvedModel["source"], string> = {
  task: "the task's reviewer model",
  project: "the project's reviewer model",
  automation: "the automation's setting",
  board: "set on the Models page",
  default: "the default",
  label: "picked by a task label",
  tier: "the task's suggested tier",
  fallback: "the light tier, as nothing else is set",
};

export interface ResolvesTo {
  ok: boolean;
  /** "Resolves to Codex · gpt-5.5 (high), from the Standard tier (the default)." or why nothing can run it. */
  text: string;
  /** The resolver's notes: a preferred provider passed over, a tier with no model for the provider. */
  note: string | null;
}

/**
 * The line under an operation's picker: what runs it now, and why. With no task in context (the Models page), an
 * operation on a task that comes down to the task's own model says so instead of naming the light tier.
 */
export function resolvesTo(op: OperationId, ctx: OperationContext, settings: OperationSettings): ResolvesTo {
  const resolution = resolveOperationModel(op, ctx, settings);
  if (!resolution.ok) return { ok: false, text: resolution.reason, note: null };
  if (OPERATIONS[op].taskScoped && !ctx.task && isTaskOwnModel(resolution)) {
    return {
      ok: true,
      text: "Resolves to the task's own model: a custom model one of its labels picks, else its suggested tier.",
      note: null,
    };
  }
  const { profile, explicit } = resolution.choice;
  const named = explicit
    ? null
    : profile?.tier
      ? `the ${profile.name} tier`
      : profile
        ? `custom model ${profile.name}`
        : null;
  const why = named ? `from ${named} (${SOURCE_WORDS[resolution.source]})` : SOURCE_WORDS[resolution.source];
  return { ok: true, text: `Resolves to ${shortResolution(resolution)}, ${why}.`, note: resolution.note };
}

/** The inherit row's detail: what the operation runs on when this level sets nothing. */
export function inheritDetail(op: OperationId, ctx: OperationContext, settings: OperationSettings): string {
  return shortResolution(resolveOperationModel(op, ctx, settings), OPERATIONS[op].taskScoped && !ctx.task);
}
