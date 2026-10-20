import type { CliEffort } from "@repo/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { DEFAULT_EFFORT, effortItems, effortOfValue } from "./cliEffort.logic";

/**
 * The effort a CLI runs a model at: the model's levels, or "Default effort" for the CLI's own. Used beside the model in
 * the launch dialogs and on the Model tiers page.
 */
export function CliEffortPicker({
  value,
  levels,
  onChange,
  label = "Effort",
  variant = "default",
  disabled,
  className,
}: {
  value: CliEffort | null;
  levels: readonly CliEffort[];
  onChange: (effort: CliEffort | null) => void;
  label?: string;
  variant?: "default" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const items = effortItems(levels, value);
  return (
    <Select
      items={items}
      value={value ?? DEFAULT_EFFORT}
      disabled={disabled}
      onValueChange={(next) => onChange(effortOfValue(next))}
    >
      <SelectTrigger size="sm" variant={variant} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
