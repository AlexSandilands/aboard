import {
  type AutopilotAutomation,
  type AutopilotEngineSettings,
  type FindingSeverity,
  type UpdateAutopilotEngineInput,
} from "@repo/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import {
  SETTINGS_TEXT_WIDTH,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  StatusDot,
  UnitInput,
} from "~/components/settings/settingsLayout";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { Button } from "~/components/ui/button";
import { useUpdateAutopilotEngine } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { parseLimit } from "./autopilot.logic";
import { TimeInput } from "./TimeInput";
import { scopeIsOn } from "./where.logic";
import { useWhere } from "./useWhere";
import { BoardVariablesSection } from "./VariablesSection";

const FIX_THRESHOLDS: ReadonlyArray<{ value: FindingSeverity; label: string }> = [
  { value: "blocking", label: "Blocking only" },
  { value: "major", label: "Major and up" },
  { value: "minor", label: "Minor and up" },
  { value: "nit", label: "Everything" },
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

/**
 * A project's Autopilot in its settings, read only: what each automation does here and why, with a Change link to the
 * automation's Where it runs in Settings → Autopilot. The one place that edits where an automation runs, besides the
 * lane's pill, is that widget.
 */
export function ProjectAutopilotSection({ projectId }: { projectId: string }) {
  const overview = useAutopilotOverview();
  return (
    <SettingsSection id="project.autopilot.automations" title="Automations">
      {!overview.data ? (
        <SettingsNote>{overview.error ? overview.error.message : "Loading automations..."}</SettingsNote>
      ) : overview.data.automations.length === 0 ? (
        <SettingsNote>No automations are installed yet.</SettingsNote>
      ) : (
        overview.data.automations.map((automation) => (
          <ProjectAutomationRow key={automation.key} automation={automation} projectId={projectId} />
        ))
      )}
    </SettingsSection>
  );
}

function ProjectAutomationRow({ automation, projectId }: { automation: AutopilotAutomation; projectId: string }) {
  const { input, description } = useWhere(automation);
  const openSettings = useOpenSettings();
  const on = input ? scopeIsOn(input, { kind: "project", id: projectId }) : null;
  return (
    <SettingsRow
      title={automation.title}
      description={description ? description.sentence : "Loading..."}
      status={
        on === null ? null : (
          <span className="flex items-center gap-1.5">
            <StatusDot tone={on ? "success" : "muted"} label={on ? "On here" : "Off here"} />
            {on ? "On here" : "Off here"}
          </span>
        )
      }
      control={
        <Button
          size="xs"
          variant="outline"
          aria-label={`Change where ${automation.title} runs`}
          onClick={() => openSettings(`autopilot.automations.${automation.key}`)}
        >
          Change
        </Button>
      }
    />
  );
}

/** The engine's settings in three cards: spending and timing, the PR automations' limits, and safety. */
function EngineSections({ engine }: { engine: AutopilotEngineSettings }) {
  const update = useUpdateAutopilotEngine();
  const save = (input: UpdateAutopilotEngineInput) => update.mutate(input);
  return (
    <>
      <SettingsSection id="autopilot.limits.spending" title="Spending & timing">
        <SettingsRow
          id="autopilot.limits.max-concurrent"
          title="Agent runs at once"
          description="How many of Autopilot's agent runs can be open at once. Not a limit on your machine."
          info="Counts runs Autopilot has open. A T3 thread Autopilot started counts only against Start planned, while it is working; threads you start yourself never count."
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
          id="autopilot.limits.daily-run-cap"
          title="Daily run cap"
          description="The most agent runs to start per day (local time). Empty is no cap."
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
          id="autopilot.limits.daily-spend-cap"
          title="Daily spend cap"
          description="No more agent runs start once today's have cost this much (local time). Empty is no cap."
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
          id="autopilot.limits.quiet-hours"
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
      </SettingsSection>
      <SettingsSection id="autopilot.limits.pull-requests" title="Pull requests">
        <SettingsRow
          id="autopilot.limits.pr-review-rounds"
          title="PR review rounds"
          description="How many review rounds the PR review automation runs, and Fix PRs' attempts on its review and failing checks."
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
          id="autopilot.limits.pr-comment-rounds"
          title="PR comment rounds"
          description="How many attempts Fix PRs makes on other people's review comments and requests for changes."
          control={
            <LimitInput
              label="PR comment rounds"
              value={engine.prCommentRounds}
              min={1}
              max={10}
              integer
              required
              unit="rounds"
              onSave={(next) => save({ prCommentRounds: next ?? 5 })}
            />
          }
        />
        <SettingsRow
          id="autopilot.limits.pr-fix-threshold"
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
              <SelectTrigger size="sm" className={SETTINGS_TEXT_WIDTH} aria-label="PR fix threshold">
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
      </SettingsSection>
      <SettingsSection id="autopilot.limits.safety" title="Safety">
        <SettingsRow
          id="autopilot.limits.dry-run"
          title="Dry run"
          description="Every automation records what it would do as a skipped run, and does nothing."
          info="Turn it on to watch a new automation before trusting it. A custom automation's check script still runs, so it can tell what it would act on."
          control={
            <Switch aria-label="Dry run" checked={engine.dryRun} onCheckedChange={(next) => save({ dryRun: next })} />
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
      <BoardVariablesSection />
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
