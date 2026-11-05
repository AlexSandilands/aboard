// Design D's Operations: the baseline's rows (ModelsPage.tsx), with the picker in the same field look as the rest of
// the page and a reason nothing can run an operation in the amber the provider dots use for "what to fix".
import { OPERATIONS, type AppSettings, type OperationId } from "@repo/contracts";
import { resolvesTo } from "~/components/models/choicePicker.logic";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import {
  boardPickerRows,
  boardPickerValue,
  boardUpdate,
  OPERATION_DESCRIPTIONS,
  OPERATION_GROUPS,
  operationTarget,
} from "~/components/models/operations.logic";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { SettingsRow, SettingsSection, SettingsSubsection } from "../../settingsLayout";
import { CONTROL_PICKER } from "./SplitCard";

/**
 * The model each operation runs on, at board level, with the line saying what that comes down to now. A project, a
 * task (for the reviewer) and an automation can pick their own; those are set where they live.
 */
export function OperationsSection({ settings }: { settings: AppSettings }) {
  return (
    <SettingsSubsection id="agents.operations">
      {OPERATION_GROUPS.map((group) => (
        <SettingsSection key={group.id} id={`agents.operations.${group.id}`} title={group.title}>
          {group.operations.map((op) => (
            <OperationRow key={op} op={op} settings={settings} />
          ))}
        </SettingsSection>
      ))}
    </SettingsSubsection>
  );
}

function OperationRow({ op, settings }: { op: OperationId; settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const { unset, inherit } = boardPickerRows(op, settings);
  const line = resolvesTo(op, {}, settings);
  return (
    <SettingsRow
      id={operationTarget(op)}
      title={OPERATIONS[op].label}
      description={OPERATION_DESCRIPTIONS[op]}
      status={
        <span className={cn("block", !line.ok && "text-warning-foreground")}>
          {line.text}
          {line.note ? <span className="block text-muted-foreground/80">{line.note}</span> : null}
        </span>
      }
      control={
        <ModelChoicePicker
          op={op}
          value={boardPickerValue(op, settings.operationModels)}
          unset={unset}
          inherit={inherit}
          ariaLabel={`${OPERATIONS[op].label} model`}
          size="sm"
          className={CONTROL_PICKER}
          onChange={(next) => updateSettings.mutate({ operationModels: boardUpdate(op, next) })}
        />
      }
    />
  );
}
