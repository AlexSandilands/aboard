import type { AutopilotEngineSettings, FindingSeverity, UpdateAutopilotEngineInput } from "@repo/contracts";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useSetAutopilotPaused, useUpdateAutopilotEngine } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { AutomationRows } from "./AutomationRows";
import { CustomAutomationsSection, type CustomEdit } from "./CustomAutomationsSection";
import { parseLimit } from "./autopilot.logic";

const FIX_THRESHOLDS: ReadonlyArray<{ value: FindingSeverity; label: string }> = [
  { value: "blocking", label: "Blocking only" },
  { value: "major", label: "Major and up" },
  { value: "minor", label: "Minor and up" },
  { value: "nit", label: "Everything" },
];

/**
 * Settings → Autopilot: Pause all, the engine's limits, the board-level switch and config of every automation, then
 * the custom automations. Reads and writes its own queries; the custom automation editor is the caller's, so it can
 * take over the dialog.
 */
export function AutopilotSettingsSection({ onEditCustom }: { onEditCustom: (edit: CustomEdit) => void }) {
  const overview = useAutopilotOverview();
  if (!overview.data) {
    return (
      <SettingsSection title="Autopilot">
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          {overview.error ? overview.error.message : "Loading Autopilot..."}
        </p>
      </SettingsSection>
    );
  }
  return (
    <>
      <SettingsSection title="Autopilot">
        <EngineRows paused={overview.data.paused} engine={overview.data.engine} />
      </SettingsSection>
      <SettingsSection title="Autopilot automations">
        <AutomationRows projectId={null} />
      </SettingsSection>
      <CustomAutomationsSection onEdit={onEditCustom} />
    </>
  );
}

/** A project's own Autopilot switches and config, in its settings. Left out while there are no automations. */
export function ProjectAutopilotSection({ projectId }: { projectId: string }) {
  const automations = useAutopilotOverview().data?.automations;
  if (!automations?.length) return null;
  return (
    <SettingsSection title="Autopilot">
      <AutomationRows projectId={projectId} />
    </SettingsSection>
  );
}

function EngineRows({ paused, engine }: { paused: boolean; engine: AutopilotEngineSettings }) {
  const setPaused = useSetAutopilotPaused();
  const update = useUpdateAutopilotEngine();
  const save = (input: UpdateAutopilotEngineInput) => update.mutate(input);
  return (
    <>
      <SettingsRow
        title="Pause all"
        description="Stops every new Autopilot run, whatever the switches say. Runs already going finish. A backup restore never lifts it."
        control={<Switch aria-label="Pause all" checked={paused} onCheckedChange={(next) => setPaused.mutate(next)} />}
      />
      <SettingsRow
        title="Dry run"
        description="Records what each automation would do as a skipped run and does nothing. Turn it on to watch a new automation before trusting it."
        control={
          <Switch aria-label="Dry run" checked={engine.dryRun} onCheckedChange={(next) => save({ dryRun: next })} />
        }
      />
      <SettingsRow
        title="Agent runs at once"
        description="How many automations that start an agent can run at the same time."
        control={
          <LimitInput
            label="Agent runs at once"
            value={engine.maxConcurrent}
            min={1}
            max={10}
            integer
            required
            onSave={(next) => save({ maxConcurrent: next ?? 1 })}
          />
        }
      />
      <SettingsRow
        title="Daily run cap"
        description="The most agent runs to start per day (local time). Leave empty for no cap."
        control={
          <LimitInput
            label="Daily run cap"
            value={engine.dailyRunCap}
            min={1}
            max={1000}
            integer
            unit="runs"
            onSave={(next) => save({ dailyRunCap: next })}
          />
        }
      />
      <SettingsRow
        title="Daily spend cap"
        description="No more agent runs start once today's runs have cost this much. Leave empty for no cap."
        control={
          <LimitInput
            label="Daily spend cap"
            value={engine.dailySpendCapUsd}
            min={0.01}
            max={10000}
            integer={false}
            unit="USD"
            onSave={(next) => save({ dailySpendCapUsd: next })}
          />
        }
      />
      <SettingsRow
        title="Quiet hours"
        description="No agent runs start in this window (local time, and it may cross midnight). Automations that only change the board still run."
        control={
          <>
            <TimeInput
              label="Quiet hours start"
              value={engine.quietHours.start}
              disabled={!engine.quietHours.enabled}
              onSave={(start) => save({ quietHours: { start } })}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <TimeInput
              label="Quiet hours end"
              value={engine.quietHours.end}
              disabled={!engine.quietHours.enabled}
              onSave={(end) => save({ quietHours: { end } })}
            />
            <Switch
              aria-label="Quiet hours"
              checked={engine.quietHours.enabled}
              onCheckedChange={(enabled) => save({ quietHours: { enabled } })}
            />
          </>
        }
      />
      <SettingsRow
        title="PR review rounds"
        description="How many review rounds the PR review automation runs on a pull request."
        control={
          <LimitInput
            label="PR review rounds"
            value={engine.prReviewRounds}
            min={1}
            max={10}
            integer
            required
            unit="rounds"
            onSave={(next) => save({ prReviewRounds: next ?? 3 })}
          />
        }
      />
      <SettingsRow
        title="PR fix threshold"
        description="The lowest severity of finding the PR automations ask an agent to fix."
        control={
          <Select
            items={FIX_THRESHOLDS}
            value={engine.prFixThreshold}
            onValueChange={(value) => {
              if (value) save({ prFixThreshold: value });
            }}
          >
            <SelectTrigger size="sm" className="sm:w-40" aria-label="PR fix threshold">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {FIX_THRESHOLDS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Worktree retention"
        description="How long a finished headless run's worktree is kept when its PR hasn't merged. Worktrees with uncommitted changes are always kept."
        control={
          <LimitInput
            label="Worktree retention"
            value={engine.worktreeRetentionDays}
            min={1}
            max={365}
            integer
            required
            unit="days"
            onSave={(next) => save({ worktreeRetentionDays: next ?? 7 })}
          />
        }
      />
    </>
  );
}

/**
 * A number saved on blur or Enter. Empty means no limit (unless `required`, which puts the old value back); a value
 * out of range is put back with a note. Remounts when the saved value changes, to show what the server kept.
 */
function LimitInput({
  label,
  value,
  min,
  max,
  integer,
  required = false,
  unit,
  onSave,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  integer: boolean;
  required?: boolean;
  unit?: string;
  onSave: (next: number | null) => void;
}) {
  const shown = value === null ? "" : String(value);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        key={shown}
        aria-label={label}
        size="sm"
        font="mono"
        inputMode="decimal"
        className="w-24"
        placeholder={required ? undefined : "No cap"}
        defaultValue={shown}
        onBlur={(event) => {
          const input = event.currentTarget;
          const next = parseLimit(input.value, { min, max, integer });
          if (next === undefined || (next === null && required)) {
            input.value = shown;
            toastManager.add({
              type: "warning",
              title: `${label} not saved`,
              description: `Enter ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`,
            });
          } else if (next !== value) onSave(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
    </span>
  );
}

/** A 24-hour time saved when the field loses focus with a complete time. */
function TimeInput({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  return (
    <Input
      key={value}
      type="time"
      aria-label={label}
      size="sm"
      font="mono"
      className="w-32"
      disabled={disabled}
      defaultValue={value}
      onBlur={(event) => {
        const next = event.currentTarget.value;
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(next) && next !== value) onSave(next);
        else event.currentTarget.value = value;
      }}
    />
  );
}
