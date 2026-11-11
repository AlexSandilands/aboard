// Settings → Agents → Operations: the model each operation runs on, with the picker in the same field look as the
// rest of the page. While no provider can run anything the rows are dimmed behind one notice instead of a warning on
// each.
import { AgentHarness, OPERATIONS, PROVIDERS, type ModelChoice, type OperationId } from "@repo/contracts";
import { CircleAlertIcon, TerminalIcon } from "lucide-react";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { memo, useCallback } from "react";
import { useUpdateSettings } from "~/state/mutations";
import { useOperationSettings } from "~/state/queries";
import { SettingsRow, SettingsSection, SettingsSubsection } from "../settingsLayout";
import { CONTROL_PICKER } from "./SplitCard";

const HEADLESS_LABELS = AgentHarness.options.map((h) => PROVIDERS[h].label);

/**
 * The model each operation runs on, at board level, with the line saying what that comes down to now. A project, a
 * task (for the reviewer) and an automation can pick their own; those are set where they live.
 */
/**
 * `blocked`: no CLI provider is switched on. Every operation runs headless on one; with none (T3 Code alone, or all
 * off) each row would carry the same "needs a provider" warning.
 */
export const OperationsSection = memo(function OperationsSection({ blocked }: { blocked: boolean }) {
  const groups = OPERATION_GROUPS.map((group) => (
    <SettingsSection key={group.id} id={`agents.operations.${group.id}`} title={group.title}>
      {group.operations.map((op) => (
        <OperationRow key={op} op={op} quiet={blocked} />
      ))}
    </SettingsSection>
  ));
  return (
    <SettingsSubsection id="agents.operations">
      {blocked ? (
        <div className="relative">
          <div
            inert
            aria-hidden
            className="max-h-[26rem] space-y-6 overflow-hidden opacity-40 grayscale select-none [mask-image:linear-gradient(to_bottom,black_40%,transparent)]"
          >
            {groups}
          </div>
          <div className="absolute inset-x-0 top-16 flex justify-center px-4">
            <div className="w-full max-w-md rounded-xl border border-border/60 bg-card/85 shadow-lg/5 backdrop-blur-sm">
              <Empty size="compact" className="min-h-0 gap-3 py-6 md:p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <TerminalIcon />
                  </EmptyMedia>
                  <EmptyTitle>Finish setting up your providers</EmptyTitle>
                  <EmptyDescription>
                    Reviews, Autopilot and the board's tools run on {listOr(HEADLESS_LABELS)}. Add or switch on one of
                    them in Providers above.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          </div>
        </div>
      ) : (
        groups
      )}
    </SettingsSubsection>
  );
});

function listOr(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * One operation's row. It reads only what its line and picker depend on (useOperationSettings), so a pick on another
 * row, or any other setting, doesn't re-render it.
 */
const OperationRow = memo(function OperationRow({ op, quiet }: { op: OperationId; quiet: boolean }) {
  const settings = useOperationSettings(op);
  const { mutate } = useUpdateSettings();
  const onChange = useCallback(
    (next: ModelChoice | null) => mutate({ operationModels: boardUpdate(op, next) }),
    [mutate, op],
  );
  if (!settings) return null;
  const { unset, inherit } = boardPickerRows(op, settings);
  const line = resolvesTo(op, {}, settings);
  return (
    <SettingsRow
      id={operationTarget(op)}
      title={OPERATIONS[op].label}
      info={OPERATION_DESCRIPTIONS[op]}
      description={quiet ? OPERATION_DESCRIPTIONS[op] : undefined}
      status={
        quiet ? null : line.ok ? (
          <span className="block">
            {line.text}
            {line.note ? <span className="block text-muted-foreground/80">{line.note}</span> : null}
          </span>
        ) : (
          // A single row that can't run (its provider lacks something it needs): said calmly, with a small marker.
          <span className="flex items-start gap-1.5">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning/80" />
            <span>{line.text}</span>
          </span>
        )
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
          onChange={onChange}
        />
      }
    />
  );
});
