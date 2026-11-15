import { useState } from "react";
import {
  RUNNER_CHOICES,
  T3_RUNTIME_MODES,
  type AutopilotAgentDefaults,
  type AutopilotEngineSettings,
  type AutopilotLimits as Limits,
  type UpdateAutopilotEngineInput,
} from "@repo/contracts";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import {
  SETTINGS_TEXT_WIDTH,
  SettingsLink,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  UnitInput,
} from "~/components/settings/settingsLayout";
import { useAutopilotMachines, useUpdateMachineLimits } from "~/state/autopilotMachines";
import { useUpdateAutopilotEngine } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { parseLimit } from "./autopilot.logic";
import {
  limitMachines,
  machineLimitsNote,
  targetMachine,
  targetOf,
  targetValue,
  type LimitsTarget,
} from "./machines.logic";
import { TimeInput } from "./TimeInput";
import { VariablesSection } from "./VariablesSection";

// The row's description says what Auto means, so the select uses the short names.
const RUNNER_OPTIONS = RUNNER_CHOICES.map(({ value, short }) => ({
  value,
  label: short,
}));

const T3_ACCESS_OPTIONS: ReadonlyArray<{
  value: AutopilotAgentDefaults["t3Access"];
  label: string;
}> = [
  { value: "default", label: "T3 Code's default" },
  ...T3_RUNTIME_MODES.map((m) => ({ value: m.value, label: m.label })),
];

/** Settings → Autopilot → Limits & safety: the engine's limits, then the variables custom automations read. */
export function AutopilotLimits() {
  const overview = useAutopilotOverview();
  if (!overview.data) {
    return (
      <SettingsSection title="Limits & safety">
        <SettingsNote>{overview.error ? overview.error.message : "Loading Autopilot..."}</SettingsNote>
      </SettingsSection>
    );
  }
  return <EngineSections engine={overview.data.engine} />;
}

/** The engine's settings in three cards: spending and timing, the defaults for agent runs, and safety. */
function EngineSections({ engine }: { engine: AutopilotEngineSettings }) {
  const update = useUpdateAutopilotEngine();
  const save = (input: UpdateAutopilotEngineInput) => update.mutate(input);
  return (
    <>
      <LimitsSection engine={engine} />
      <SettingsSection
        id="autopilot.limits.agent-defaults"
        title="Defaults for agent runs"
        headerAction={
          <span className="text-xs text-muted-foreground">
            Models: <SettingsLink to="agents.operations">Agents → Operations</SettingsLink>
          </span>
        }
      >
        <SettingsRow
          id="autopilot.limits.runner"
          title="Where agents run"
          description="Where its runs start."
          info="Auto: a T3 Code thread when T3 Code is connected, else a headless CLI in a worktree. Some runs are always headless, whatever this says: Review PRs, runs with no task (the digest, scheduled automations) and custom automations that give their agent extra tools."
          control={
            <OptionSelect
              label="Where agents run"
              options={RUNNER_OPTIONS}
              value={engine.agentDefaults.runner}
              onSave={(runner) => save({ agentDefaults: { runner } })}
            />
          }
        />
        <SettingsRow
          id="autopilot.limits.budget"
          title="Budget per headless run"
          description="Claude Code only."
          info="Codex and Copilot CLI runs have no spending cap and report no cost: only the timeout stops them."
          control={
            <LimitInput
              label="Budget per headless run"
              value={engine.agentDefaults.budgetUsd}
              min={0.5}
              max={100}
              integer={false}
              required
              unit="USD"
              onSave={(next) => {
                if (next !== null) save({ agentDefaults: { budgetUsd: next } });
              }}
            />
          }
        />
        <SettingsRow
          id="autopilot.limits.timeout"
          title="Timeout per headless run"
          description="Stops a run after this long."
          control={
            <LimitInput
              label="Timeout per headless run"
              value={engine.agentDefaults.timeoutMinutes}
              min={1}
              max={1440}
              integer
              required
              unit="minutes"
              onSave={(next) => {
                if (next !== null) save({ agentDefaults: { timeoutMinutes: next } });
              }}
            />
          }
        />
        <SettingsRow
          id="autopilot.limits.t3-access"
          title="T3 Code access"
          description="Never more than T3 Code's own default."
          info="The most access a T3 Code thread that Autopilot starts gets."
          control={
            <OptionSelect
              label="T3 Code access"
              options={T3_ACCESS_OPTIONS}
              value={engine.agentDefaults.t3Access}
              onSave={(t3Access) => save({ agentDefaults: { t3Access } })}
            />
          }
        />
        <SettingsNote>Each automation can override these under its Advanced settings.</SettingsNote>
      </SettingsSection>
      <SettingsSection id="autopilot.limits.advanced" title="Advanced">
        <SettingsRow
          id="autopilot.limits.preview-everything"
          title="Preview everything"
          description="Every automation records what it would do, and does nothing."
          info="Its runs are marked Preview. To try one new automation, set its own Mode to Preview instead: the others keep working. A custom automation's check script still runs for real, so it can tell what it would act on."
          control={
            <Switch
              aria-label="Preview everything"
              checked={engine.dryRun}
              onCheckedChange={(next) => save({ dryRun: next })}
            />
          }
        />
        <SettingsRow
          id="autopilot.limits.worktree-retention"
          title="Worktree retention"
          description="How long a finished headless run's worktree is kept while its PR is unmerged."
          info="Worktrees with uncommitted changes are always kept."
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
      </SettingsSection>
      <VariablesSection />
    </>
  );
}

/**
 * Spending & timing: Autopilot's limits on this board, or with "Limits for" on a connected machine whose Autopilot
 * runs the tasks it holds (remote-machines.md#autopilot-on-the-machine). Each machine counts only its own runs.
 */
function LimitsSection({ engine }: { engine: AutopilotEngineSettings }) {
  const machines = limitMachines(useAutopilotMachines().data ?? []);
  const [target, setTarget] = useState<LimitsTarget>("board");
  const machine = targetMachine(target, machines);
  const updateBoard = useUpdateAutopilotEngine();
  const updateMachine = useUpdateMachineLimits(machine?.id ?? "");
  const limits: Limits = machine ? machine.limits : engine;
  const saveLimits = (input: UpdateAutopilotEngineInput) => {
    if (machine) updateMachine.mutate(input);
    else updateBoard.mutate(input);
  };
  const note = machine ? machineLimitsNote(machine) : null;
  const options = [
    { value: "board", label: "This board" },
    ...machines.map((m) => ({
      value: m.id,
      label: m.connection === "connected" ? m.name : `${m.name} · offline`,
    })),
  ];
  return (
    <SettingsSection
      id="autopilot.limits.spending"
      title="Spending & timing"
      headerAction={
        machines.length > 0 ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            Limits for
            <OptionSelect
              label="Limits for"
              options={options}
              value={machine ? targetValue(target) : "board"}
              onSave={(next) => setTarget(targetOf(next))}
            />
          </span>
        ) : undefined
      }
    >
      {machine && note ? (
        <div className="px-3 pt-3 sm:px-4">
          <Alert variant={note.tone === "warning" ? "warning" : "info"} className="px-2.5 py-1.5 text-xs">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{note.text}</span>
              {machine.ownLimits ? (
                <Button size="xs" variant="outline" onClick={() => updateMachine.mutate({ reset: true })}>
                  Use this board's
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <SettingsRow
        id="autopilot.limits.max-concurrent"
        title="Agent runs at once"
        description="How many of Autopilot's agent runs can be open at once."
        info="Counts runs Autopilot has open. A T3 thread Autopilot started counts only against Start planned, while it is working; threads you start yourself never count."
        control={
          <LimitInput
            label="Agent runs at once"
            value={limits.maxConcurrent}
            min={1}
            max={10}
            integer
            required
            onSave={(next) => saveLimits({ maxConcurrent: next ?? 1 })}
          />
        }
      />
      <SettingsRow
        id="autopilot.limits.daily-run-cap"
        title="Daily run cap"
        description="The most agent runs to start per day (local time). Empty is no cap."
        control={
          <LimitInput
            label="Daily run cap"
            value={limits.dailyRunCap}
            min={1}
            max={1000}
            integer
            unit="runs"
            onSave={(next) => saveLimits({ dailyRunCap: next })}
          />
        }
      />
      <SettingsRow
        id="autopilot.limits.daily-spend-cap"
        title="Daily spend cap"
        description="No more runs start once today's cost this much. Empty is no cap."
        control={
          <LimitInput
            label="Daily spend cap"
            value={limits.dailySpendCapUsd}
            min={0.01}
            max={10000}
            integer={false}
            unit="USD"
            onSave={(next) => saveLimits({ dailySpendCapUsd: next })}
          />
        }
      />
      <SettingsRow
        id="autopilot.limits.quiet-hours"
        title="Quiet hours"
        description="No agent runs start in this window (local time)."
        info="The window may cross midnight. Automations that only change the board still run."
        control={
          <>
            <TimeInput
              label="Quiet hours start"
              value={limits.quietHours.start}
              disabled={!limits.quietHours.enabled}
              onSave={(start) => saveLimits({ quietHours: { start } })}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <TimeInput
              label="Quiet hours end"
              value={limits.quietHours.end}
              disabled={!limits.quietHours.enabled}
              onSave={(end) => saveLimits({ quietHours: { end } })}
            />
            <Switch
              aria-label="Quiet hours"
              checked={limits.quietHours.enabled}
              onCheckedChange={(enabled) => saveLimits({ quietHours: { enabled } })}
            />
          </>
        }
      />
    </SettingsSection>
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
    <UnitInput
      key={shown}
      aria-label={label}
      unit={unit}
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
  );
}

/** A select of fixed options, saved when one is picked. */
function OptionSelect<V extends string>({
  label,
  options,
  value,
  onSave,
}: {
  label: string;
  options: ReadonlyArray<{ value: V; label: string }>;
  value: V;
  onSave: (next: V) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== value) onSave(next);
      }}
    >
      <SelectTrigger size="sm" className={SETTINGS_TEXT_WIDTH} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
