import type { AutopilotEngineSettings, FindingSeverity, UpdateAutopilotEngineInput } from "@repo/contracts";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { useSetAutopilotPaused, useUpdateAutopilotEngine } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { AutomationRows, AutomationSections } from "./AutomationRows";
import { parseLimit } from "./autopilot.logic";
import { TimeInput } from "./TimeInput";

const FIX_THRESHOLDS: ReadonlyArray<{ value: FindingSeverity; label: string }> = [
  { value: "blocking", label: "Blocking only" },
  { value: "major", label: "Major and up" },
  { value: "minor", label: "Minor and up" },
  { value: "nit", label: "Everything" },
];

/**
 * Settings → Autopilot: Pause all and the engine's limits, then the board-level switch and config of every
 * automation, one folded section each. Reads and writes its own queries.
 */
export function AutopilotEngineSection() {
  const overview = useAutopilotOverview();
  return (
    <>
      <SettingsSection id="autopilot.engine.settings" title="Autopilot">
        {overview.data ? (
          <EngineRows paused={overview.data.paused} engine={overview.data.engine} />
        ) : (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            {overview.error ? overview.error.message : "Loading Autopilot..."}
          </p>
        )}
      </SettingsSection>
      <div className="space-y-2.5">
        <h2 className="flex min-h-7 items-center px-3 text-sm font-normal text-foreground/70 sm:px-4">Automations</h2>
        <AutomationSections />
      </div>
    </>
  );
}

/** A project's own Autopilot switches and config, in its settings. */
export function ProjectAutopilotSection({ projectId }: { projectId: string }) {
  return (
    <SettingsSection id="project.autopilot.automations" title="Autopilot overrides">
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
        id="autopilot.engine.pause-all"
        title="Pause all"
        description="Stops every new Autopilot run, whatever the switches say."
        info="Runs already going finish. A backup restore never lifts it."
        control={<Switch aria-label="Pause all" checked={paused} onCheckedChange={(next) => setPaused.mutate(next)} />}
      />
      <SettingsRow
        id="autopilot.engine.dry-run"
        title="Dry run"
        description="Records what each automation would do as a skipped run, and does nothing."
        info="Turn it on to watch a new automation before trusting it."
        control={
          <Switch aria-label="Dry run" checked={engine.dryRun} onCheckedChange={(next) => save({ dryRun: next })} />
        }
      />
      <SettingsRow
        id="autopilot.engine.max-concurrent"
        title="Agent runs at once"
        description="How many agent runs can go at the same time."
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
        id="autopilot.engine.daily-run-cap"
        title="Daily run cap"
        description="The most agent runs to start per day. Empty is no cap."
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
        id="autopilot.engine.daily-spend-cap"
        title="Daily spend cap"
        description="No more agent runs start once today's have cost this much. Empty is no cap."
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
        id="autopilot.engine.quiet-hours"
        title="Quiet hours"
        description="No agent runs start in this window (local time)."
        info="The window may cross midnight. Automations that only change the board still run."
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
        id="autopilot.engine.pr-review-rounds"
        title="PR review rounds"
        description="How many review rounds the PR review automation runs."
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
        id="autopilot.engine.pr-fix-threshold"
        title="PR fix threshold"
        description="The lowest severity the PR automations ask an agent to fix."
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
        id="autopilot.engine.worktree-retention"
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
