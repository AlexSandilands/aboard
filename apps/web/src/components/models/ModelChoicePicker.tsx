import {
  AGENT_HARNESSES,
  CliEffort,
  INHERIT,
  MODEL_TIERS,
  type AgentHarness,
  type ModelChoice,
  type OperationContext,
  type OperationId,
  type OperationNeed,
  type OperationSettings,
} from "@repo/contracts";
import { effortLabel } from "~/components/handoff/cliEffort.logic";
import { useAgentModels, useSettings } from "~/state/queries";
import {
  choiceEffortColumn,
  choiceForPick,
  choicePickerModel,
  findScanned,
  inheritDetail,
  modelLevels,
  parsePickKey,
  typedRows,
  type PickedChoice,
} from "./choicePicker.logic";
import { EffortColumn } from "./EffortColumn";
import { ModelPicker } from "./ModelPicker";
import type { PickerIcon } from "./modelPicker.logic";

/** Asks the CLIs for their models only once one is added: the scan starts the CLI. */
const hasHarness = (settings: OperationSettings | undefined) =>
  !!settings?.providers.some((p) => p.id !== "t3-code" && p.enabled);

/**
 * The shared picker for a ModelChoice: inherit, a tier, a custom model, or one provider's model with its effort.
 * Providers that can't run `op` are greyed out with the reason. `inherit` names what inheriting comes down to (the
 * next level's context, resolved now); without it inherit isn't offered.
 */
export function ModelChoicePicker({
  value,
  onChange,
  op,
  needs,
  inherit,
  lockedProvider = null,
  ariaLabel,
  size,
  className,
  disabled,
}: {
  value: ModelChoice | null;
  onChange: (next: ModelChoice) => void;
  op: OperationId;
  needs?: readonly OperationNeed[];
  inherit: { label: string; ctx: OperationContext } | null;
  lockedProvider?: AgentHarness | null;
  ariaLabel: string;
  size?: "sm" | "xs";
  className?: string;
  disabled?: boolean;
}) {
  const settings = useSettings().data;
  const scanned = useAgentModels(hasHarness(settings));
  if (!settings) return null;
  const input = {
    settings,
    scanned: scanned.data,
    value,
    op,
    needs,
    choices: true,
    inherit: inherit ? { label: inherit.label, detail: inheritDetail(op, inherit.ctx, settings) } : null,
    lockedProvider,
  };
  const model = choicePickerModel(input);
  const pick = parsePickKey(model.selectedKey ?? "") ?? (inherit ? { kind: "inherit" as const } : null);
  const explicit = value && value !== INHERIT && "provider" in value ? value : null;
  const trigger = choiceTrigger(value, settings, inherit?.label ?? null);
  return (
    <ModelPicker
      model={model}
      typedRows={(query, tab) => typedRows(model, query, tab)}
      loading={scanned.isFetching}
      ariaLabel={ariaLabel}
      size={size}
      className={className}
      disabled={disabled}
      triggerLabel={trigger.label}
      triggerIcon={trigger.icon}
      triggerSuffix={explicit?.effort ? effortLabel(explicit.effort) : null}
      onPick={(row) => {
        const picked = parsePickKey(row.key);
        if (picked) onChange(choiceForPick(picked, value, scanned.data));
      }}
      effortColumn={
        <EffortColumn
          column={choiceEffortColumn(
            pick,
            explicit?.effort ?? null,
            scanned.data,
            explicit ? (findScanned(scanned.data, explicit.provider, explicit.model)?.label ?? explicit.model) : "",
          )}
          onPick={(_group, id) => {
            if (!explicit) return;
            const level = CliEffort.safeParse(id);
            const { effort: _old, ...rest } = explicit;
            onChange(level.success ? { ...rest, effort: level.data } : rest);
          }}
          onToggle={() => {}}
        />
      }
    />
  );
}

/** What the trigger shows for a saved choice. */
function choiceTrigger(
  value: ModelChoice | null,
  settings: OperationSettings,
  inheritLabel: string | null,
): { label: string | null; icon: PickerIcon | null } {
  if (!value || value === INHERIT) return { label: inheritLabel, icon: inheritLabel ? { kind: "inherit" } : null };
  if ("tier" in value) {
    return { label: `${MODEL_TIERS.find((t) => t.value === value.tier)!.label} tier`, icon: { kind: "tier" } };
  }
  if ("profile" in value) {
    const profile = settings.modelProfiles.find((p) => p.id === value.profile);
    return { label: profile?.name ?? `${value.profile} (deleted)`, icon: { kind: "custom" } };
  }
  return { label: value.model, icon: { kind: "harness", harness: value.provider } };
}

/**
 * One CLI's model and effort (a tier's cell, the launch dialogs): that CLI's models, a typed one, or its default
 * under `defaultLabel` when given. `onModel` gets the levels the new model takes, so a caller can drop an effort it
 * doesn't.
 */
export function CliModelPicker({
  harness,
  model,
  effort,
  defaultLabel,
  ariaLabel,
  size,
  className,
  onModel,
  onEffort,
}: {
  harness: AgentHarness;
  /** The saved model; null or "" for none. */
  model: string | null;
  effort: CliEffort | null;
  defaultLabel?: string;
  ariaLabel: string;
  size?: "sm" | "xs";
  className?: string;
  onModel: (model: string | null, levels: readonly CliEffort[]) => void;
  onEffort: (effort: CliEffort | null) => void;
}) {
  const settings = useSettings().data;
  const scanned = useAgentModels(true);
  if (!settings) return null;
  const saved = model?.trim() || null;
  const value: ModelChoice | null = saved ? { provider: harness, model: saved } : null;
  const picker = choicePickerModel({
    settings,
    scanned: scanned.data,
    value,
    op: null,
    choices: false,
    inherit: null,
    lockedProvider: harness,
    defaultLabel: defaultLabel ?? null,
  });
  const pick: PickedChoice = { kind: "model", provider: harness, model: saved };
  const name = saved ? (findScanned(scanned.data, harness, saved)?.label ?? saved) : null;
  return (
    <ModelPicker
      model={picker}
      typedRows={(query, tab) => typedRows(picker, query, tab)}
      loading={scanned.isFetching}
      emptyLabel={`No models listed. Type one to use it with ${AGENT_HARNESSES[harness].label}.`}
      ariaLabel={ariaLabel}
      size={size}
      className={className}
      triggerLabel={name ?? defaultLabel ?? null}
      triggerIcon={{ kind: "harness", harness }}
      triggerSuffix={saved && effort ? effortLabel(effort) : null}
      onPick={(row) => {
        const picked = parsePickKey(row.key);
        if (picked?.kind !== "model" || picked.model === saved) return;
        onModel(picked.model, modelLevels(scanned.data, harness, picked.model));
      }}
      effortColumn={
        <EffortColumn
          column={choiceEffortColumn(pick, effort, scanned.data, name ?? "")}
          onPick={(_group, id) => {
            const level = CliEffort.safeParse(id);
            onEffort(level.success ? level.data : null);
          }}
          onToggle={() => {}}
        />
      }
    />
  );
}
