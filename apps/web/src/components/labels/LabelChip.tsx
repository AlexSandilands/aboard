import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { useBoard } from "~/state/queries";
import { cn } from "~/lib/utils";
import { labelHue, labelStyle } from "./labels.logic";

const NO_COLORS: Readonly<Record<string, number>> = {};

/** Board-wide label colour overrides from the snapshot. */
export function useLabelColors(): Readonly<Record<string, number>> {
  return useBoard().data?.labelColors ?? NO_COLORS;
}

/** A tinted label chip. `hue` overrides the label's colour, e.g. for the picker's live preview. */
export function LabelChip({
  label,
  colors,
  hue,
  size = "sm",
  onRemove,
  className,
  children,
}: {
  label: string;
  colors: Readonly<Record<string, number>>;
  hue?: number;
  size?: "sm" | "default";
  /** Shows an × that removes the label. */
  onRemove?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Badge
      variant="label"
      size={size}
      style={labelStyle(hue ?? labelHue(label, colors))}
      className={cn("max-w-40 border-[color-mix(in_srgb,var(--label)_28%,transparent)]", className)}
    >
      <span className="min-w-0 truncate">{label}</span>
      {children}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove label ${label}`}
          className="-me-0.5 inline-flex cursor-pointer rounded-sm opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </Badge>
  );
}
