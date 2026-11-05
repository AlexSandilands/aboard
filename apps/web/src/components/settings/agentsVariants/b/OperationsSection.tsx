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
import { PICKER_FIELD } from "./fields";

/**
 * Operations: the model each operation runs on at board level, a card per group and a row each, with the line saying
 * what that comes down to now and why (or why nothing can run it). A project, a task and an automation can pick their
 * own where they live.
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
        // Amber, as a provider's dot is, when nothing can run it: it says what to fix, not that something broke.
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
          className={PICKER_FIELD}
          onChange={(next) => updateSettings.mutate({ operationModels: boardUpdate(op, next) })}
        />
      }
    />
  );
}
