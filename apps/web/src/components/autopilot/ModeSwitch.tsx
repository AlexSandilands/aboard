import type { AutopilotMode } from "@repo/contracts";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { AUTOPILOT_MODES } from "./autopilot.logic";

/** Inherit / On / Off for one automation at one scope. Clicking the chosen one again changes nothing. */
export function ModeSwitch({
  value,
  onChange,
  label,
  disabled,
  blocked,
}: {
  value: AutopilotMode;
  onChange: (mode: AutopilotMode) => void;
  label: string;
  disabled?: boolean;
  /** Why it can't be On (an empty required tool slot); the On button is disabled, and the others still work. */
  blocked?: string | null;
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
        // On is the one state that does something, so it wears the app's blue (as the "Auto-merge on" badge does).
        <Toggle
          key={mode.value}
          value={mode.value}
          disabled={mode.value === "on" && Boolean(blocked)}
          title={mode.value === "on" && blocked ? blocked : undefined}
          className={cn(
            mode.value === "on" &&
              "data-pressed:bg-info/16 data-pressed:text-info-foreground dark:data-pressed:bg-info/24",
          )}
        >
          {mode.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
