import { AutopilotMode } from "@repo/contracts";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { AUTOPILOT_MODES } from "./autopilot.logic";

/** Inherit / Off / Preview / On for one automation at one scope. Clicking the chosen one again changes nothing. */
export function ModeSwitch({
  value,
  onChange,
  label,
  modes = AUTOPILOT_MODES,
  disabled,
  blocked,
}: {
  value: AutopilotMode;
  onChange: (mode: AutopilotMode) => void;
  label: string;
  /** The choices to offer; the board has no Inherit. */
  modes?: ReadonlyArray<{ value: AutopilotMode; label: string }>;
  disabled?: boolean;
  /** Why it can't be on (an empty required tool slot); Preview and On are disabled, and the others still work. */
  blocked?: string | null;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      disabled={disabled}
      value={[value]}
      onValueChange={(next) => {
        const mode = AutopilotMode.safeParse(next[0]);
        if (mode.success) onChange(mode.data);
      }}
    >
      {modes.map((mode) => {
        const turnsOn = mode.value === "on" || mode.value === "preview";
        return (
          // On is the one state that does something, so it wears the app's blue (as the "Auto-merge on" badge does);
          // Preview, which only records, the amber of the Preview badge.
          <Toggle
            key={mode.value}
            value={mode.value}
            disabled={turnsOn && Boolean(blocked)}
            title={turnsOn && blocked ? blocked : undefined}
            className={cn(
              mode.value === "on" &&
                "data-pressed:bg-info/16 data-pressed:text-info-foreground dark:data-pressed:bg-info/24",
              mode.value === "preview" &&
                "data-pressed:bg-warning/16 data-pressed:text-warning-foreground dark:data-pressed:bg-warning/24",
            )}
          >
            {mode.label}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}
