import { customAutomationKey, type CustomAutomation } from "@repo/contracts";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { SETTINGS_TEXT_WIDTH, SettingsRow } from "~/components/settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useAutopilotMachines, useSetAutomationMachine } from "~/state/autopilotMachines";
import { limitMachines, runsOnDescription } from "./machines.logic";

/**
 * A scheduled custom automation's "Runs on": this board, or a connected machine whose own Autopilot then runs it
 * there, the board on or off (remote-machines.md#autopilot-on-the-machine). Shown once there is a machine to pick.
 */
export function RunsOnSection({ custom }: { custom: CustomAutomation }) {
  const machines = limitMachines(useAutopilotMachines().data ?? []);
  const setMachine = useSetAutomationMachine(custom.id);
  const pinned = custom.machineId ?? null;
  if (machines.length === 0 && !pinned) return null;
  const options = [{ value: "board", label: "This board" }, ...machines.map((m) => ({ value: m.id, label: m.name }))];
  const value = pinned ?? "board";
  const description = runsOnDescription(pinned, machines);
  return (
    <DetailSection title="Runs on">
      <SettingsRow
        id={`autopilot.automations.${customAutomationKey(custom.id)}.runs-on`}
        title="Machine"
        description={
          <span className={description.tone === "warning" ? "text-warning-foreground" : undefined}>
            {description.text}
          </span>
        }
        info="A scheduled automation runs on one machine. On a connected machine its agent, command or script runs there, with that machine's logins and limits, and its runs show here once the board hears from it."
        control={
          <Select
            items={options}
            value={value}
            onValueChange={(next) => {
              if (next !== null && next !== value) setMachine.mutate(next === "board" ? null : next);
            }}
          >
            <SelectTrigger
              size="sm"
              className={SETTINGS_TEXT_WIDTH}
              aria-label="Runs on"
              disabled={setMachine.isPending}
            >
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
        }
      />
    </DetailSection>
  );
}
