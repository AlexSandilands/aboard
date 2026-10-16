import type { AutopilotMode } from "@repo/contracts";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { AUTOPILOT_MODES } from "./autopilot.logic";

/** Inherit / On / Off for one automation at one scope. Clicking the chosen one again changes nothing. */
export function ModeSwitch({
  value,
  onChange,
  label,
  disabled,
}: {
  value: AutopilotMode;
  onChange: (mode: AutopilotMode) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      disabled={disabled}
      value={[value]}
      onValueChange={(next) => {
        const mode = next[0];
        if (mode === "inherit" || mode === "on" || mode === "off") onChange(mode);
      }}
    >
      {AUTOPILOT_MODES.map((mode) => (
        <Toggle key={mode.value} value={mode.value}>
          {mode.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
