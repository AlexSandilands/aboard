import { AUTOPILOT_ORCHESTRATE } from "@repo/contracts";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";
import { useBoardView } from "~/state/ui";
import { FieldRow, useScopeAutomations } from "./AutomationRows";
import { BOARD_MODES, boardModeToSave, boardSummary, boardSwitchValue } from "./autopilot.logic";
import { BlockedWarning } from "./InputsAndSlots";
import { ModeSwitch } from "./ModeSwitch";
import { RunHistoryLink } from "./RunHistoryLink";

/**
 * Orchestrate's own area in Settings → Autopilot, above the list of the other automations: its board switch and
 * config, and a link to its run history. What is per project (its switch, the next check, Run now) is in the project's
 * settings and the lane's popover. Reads its own queries.
 */
export function OrchestrateSettings() {
  const { items, pending = false, rejected = 0 } = useScopeAutomations(null);
  const showTimer = useBoardView((s) => s.showAutopilotTimer);
  const setShowTimer = useBoardView((s) => s.setShowAutopilotTimer);
  const item = items.find((i) => i.automation.key === AUTOPILOT_ORCHESTRATE);
  // While the catalogue loads (or fails) the Automations list below says so; there is nothing to show here yet.
  if (!item) return null;
  const { automation, entry, onMode, onConfig } = item;
  return (
    <SettingsSection id="autopilot.engine.orchestrate" title={automation.title}>
      <SettingsRow
        title={`${automation.title} for the board`}
        description={automation.description}
        status={boardSummary(entry.mode)}
        control={
          <ModeSwitch
            label={`${automation.title} for the board`}
            modes={BOARD_MODES}
            value={boardSwitchValue(entry.mode)}
            disabled={pending}
            blocked={automation.blocked}
            onChange={(mode) => onMode(boardModeToSave(mode))}
          />
        }
      >
        {automation.blocked ? (
          <div className="mt-2">
            <BlockedWarning reason={automation.blocked} />
          </div>
        ) : null}
      </SettingsRow>
      {automation.fields.map((field) => (
        <div key={field.key} className="@container/settings-row px-3 sm:px-4">
          <FieldRow
            automation={automation}
            field={field}
            entry={entry}
            projectId={null}
            rejected={rejected}
            onConfig={onConfig}
          />
        </div>
      ))}
      <SettingsRow
        id="autopilot.engine.orchestrate.countdown"
        title="Countdown on lanes"
        description="The lane's Autopilot pill counts down to Orchestrate's next check (Autopilot · 12m) while it is on in the project."
        control={<Switch checked={showTimer} onCheckedChange={setShowTimer} aria-label="Countdown on lanes" />}
      />
      <SettingsRow
        title="Run history"
        description="Every run, with what it said it did and the handover it left. Searchable, and runs can be deleted there."
        control={<RunHistoryLink automation={AUTOPILOT_ORCHESTRATE} />}
      />
    </SettingsSection>
  );
}
