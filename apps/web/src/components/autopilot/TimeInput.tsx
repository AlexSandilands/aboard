import { SETTINGS_NUMBER_WIDTH } from "~/components/settings/settingsLayout";
import { Input } from "~/components/ui/input";
import { isClockTime } from "./autopilot.logic";

/** A 24-hour time saved when the field loses focus with a complete time. */
export function TimeInput({
  label,
  value,
  disabled = false,
  onSave,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onSave: (next: string) => void;
}) {
  return (
    <Input
      key={value}
      type="time"
      aria-label={label}
      size="sm"
      font="mono"
      className={SETTINGS_NUMBER_WIDTH}
      disabled={disabled}
      defaultValue={value}
      onBlur={(event) => {
        const next = event.currentTarget.value;
        if (isClockTime(next) && next !== value) onSave(next);
        else event.currentTarget.value = value;
      }}
    />
  );
}
