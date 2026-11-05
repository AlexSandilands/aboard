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
import { SettingsRow, SettingsSection } from "../../settingsLayout";
import { FIELD } from "./parts";

/**
 * The model each operation runs on at board level. A row is its name, what it comes down to now in one muted line,
 * and the picker in the page's control column; what the operation is sits behind the info button.
 */
export function OperationsCards({ settings }: { settings: AppSettings }) {
  return (
    <>
      {OPERATION_GROUPS.map((group) => (
        <SettingsSection key={group.id} id={`agents.operations.${group.id}`} title={group.title}>
          {group.operations.map((op) => (
            <OperationRow key={op} op={op} settings={settings} />
          ))}
        </SettingsSection>
      ))}
    </>
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
      info={
        <>
          {OPERATION_DESCRIPTIONS[op]}
          {line.note ? <span className="mt-2 block text-muted-foreground">{line.note}</span> : null}
        </>
      }
      description={
        <span className={cn("block", !line.ok && "text-warning-foreground")} title={line.text}>
          {line.text}
        </span>
      }
      control={
        <div className="w-full @min-[32rem]/settings-row:w-[15.875rem] @min-[32rem]/settings-row:pe-[2.125rem]">
          <ModelChoicePicker
            op={op}
            value={boardPickerValue(op, settings.operationModels)}
            unset={unset}
            inherit={inherit}
            ariaLabel={`${OPERATIONS[op].label} model`}
            size="sm"
            className={FIELD}
            onChange={(next) => updateSettings.mutate({ operationModels: boardUpdate(op, next) })}
          />
        </div>
      }
    />
  );
}
