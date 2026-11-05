// Design C's Operations: the baseline's groups, each row its name (what it is behind ⓘ), one line of what it resolves
// to, and the picker as a settings field at the page's one picker width.
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
import { SettingsGroup, SettingsRow } from "../../settingsLayout";
import { PICKER_FIELD, SectionHeading } from "./parts";

export function OperationsPanel({ settings }: { settings: AppSettings }) {
  return (
    <>
      {OPERATION_GROUPS.map((group, index) => (
        <section key={group.id} id={`agents.operations.${group.id}`} className="scroll-mt-4 space-y-2.5">
          <SectionHeading
            title={group.title}
            info={
              index === 0 ? (
                <p>
                  The model each kind of run uses, board-wide. Default keeps the built-in choice. A project, a task's
                  reviewer and each automation can still pick their own where they live.
                </p>
              ) : undefined
            }
          />
          <SettingsGroup>
            {group.operations.map((op) => (
              <OperationRow key={op} op={op} settings={settings} />
            ))}
          </SettingsGroup>
        </section>
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
          <p>{OPERATION_DESCRIPTIONS[op]}</p>
          {line.note ? <p className="mt-2 text-muted-foreground">{line.note}</p> : null}
        </>
      }
      description={
        <span className={cn(!line.ok && "text-destructive-foreground")} title={line.text}>
          {line.text}
        </span>
      }
      control={
        <>
          <ModelChoicePicker
            op={op}
            value={boardPickerValue(op, settings.operationModels)}
            unset={unset}
            inherit={inherit}
            ariaLabel={`${OPERATIONS[op].label} model`}
            size="sm"
            className={cn(PICKER_FIELD, "@min-[32rem]/settings-row:w-60")}
            onChange={(next) => updateSettings.mutate({ operationModels: boardUpdate(op, next) })}
          />
          {/* The tier cards' star column, so every picker on the page ends on one edge. */}
          <span aria-hidden className="hidden w-8 shrink-0 @min-[32rem]/settings-row:block" />
        </>
      }
    />
  );
}
