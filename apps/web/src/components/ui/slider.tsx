// Adapted from T3 Code's settings sliders (apps/web/src/components/settings/SettingsPanels.tsx), MIT — see NOTICE.
// A native range input, as in T3 Code, styled by `.settings-slider` in index.css.
import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";

/** A slider with its value shown in a chip beside it (`format` renders the chip, e.g. `${v}%`). */
export function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onValueChange,
  className,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onValueChange: (value: number) => void;
  className?: string;
}) {
  const ratio = max === min ? 0 : (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    // Keeps the fill's end under the thumb's centre, which travels half a thumb less than the track.
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <div className={cn("flex w-full items-center gap-3 sm:w-52", className)}>
      <output
        className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={id}
      >
        {format(value)}
      </output>
      <input
        aria-label={label}
        className="settings-slider min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        step={step}
        style={style}
        type="range"
        value={value}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && next >= min && next <= max) onValueChange(next);
        }}
      />
    </div>
  );
}
