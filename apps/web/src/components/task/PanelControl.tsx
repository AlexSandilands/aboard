// Adapted from T3 Code (apps/web/src/components/chat/ThreadDetailsControl.tsx + threadDetailsPanelStyles.ts), MIT — see NOTICE.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/*
 * Detail-panel controls keep one density at every breakpoint, independent of toolbar
 * button sizes (T3 thread-details panel).
 */
const RESTING_SURFACE = "bg-transparent shadow-none";
const HOVER_SURFACE =
  "hover:!bg-black/[0.035] data-pressed:!bg-black/[0.035] data-popup-open:!bg-black/[0.035] dark:hover:!bg-white/[0.08] dark:data-pressed:!bg-white/[0.08] dark:data-popup-open:!bg-white/[0.08]";
const ROW_SURFACE = `${RESTING_SURFACE} ${HOVER_SURFACE}`;
const CONTROL =
  "h-8 min-w-0 rounded-lg border-transparent gap-2.5 px-2.5 text-left text-[13px] font-medium text-foreground/80";

const parts = {
  /** Full-width row: icon + label. */
  row: `${CONTROL} w-full justify-start ${ROW_SURFACE}`,
  /** Main half of a split row; sits in a PanelSplitGroup. */
  primary: `${CONTROL} flex-1 justify-start rounded-e-none ${RESTING_SURFACE} ${HOVER_SURFACE}`,
  /** Row content inside a PanelSplitGroup that owns the hover surface (rows with hover actions). */
  fill: `${CONTROL} flex-1 justify-start ${RESTING_SURFACE}`,
  /** Trailing half of a split row (menu chevron). */
  secondary: `${CONTROL} w-8 justify-center rounded-s-none px-0 ${RESTING_SURFACE} ${HOVER_SURFACE}`,
  /** Small square icon action. */
  icon: `size-6 justify-center rounded-md border-transparent p-0 text-muted-foreground ${ROW_SURFACE}`,
  /** Small text control, such as a row's secondary action. */
  meta: `h-6 gap-1 rounded-md border-transparent px-1.5 text-xs font-medium text-muted-foreground ${ROW_SURFACE}`,
};

export const PANEL_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";
/*
 * Not `truncate`: it sets `overflow: hidden`, and the `overflow-y-visible` after it would then compute to
 * `auto`, turning the label into a scroll container (the text-box trim makes glyphs spill past the box).
 * `clip` leaves the other axis alone.
 */
export const PANEL_LABEL_CLASS =
  "[text-box:trim-both_cap_alphabetic] min-w-0 overflow-x-clip overflow-y-visible text-ellipsis whitespace-nowrap";

/** A detail-panel row or action. Render as an anchor with `render={<a href />}`. */
export function PanelControl({
  part = "row",
  tone = "default",
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  part?: keyof typeof parts;
  tone?: "default" | "muted" | "primary" | "destructive";
}) {
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        type: render ? undefined : "button",
        className: cn(
          "relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap border outline-none transition-[box-shadow,scale] [&:active:not([aria-haspopup])]:scale-[0.97] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          parts[part],
          tone === "muted" && "text-muted-foreground/70 hover:text-foreground/80",
          tone === "primary" && "text-primary hover:text-primary",
          tone === "destructive" && "text-destructive-foreground",
          className,
        ),
      },
      props,
    ),
  });
}

/** Hover surface shared by a row and its trailing actions (split rows, rows with a menu). */
export function PanelSplitGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/row flex w-full min-w-0 items-center rounded-lg hover:bg-black/[0.035] has-[[data-popup-open]]:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:has-[[data-popup-open]]:bg-white/[0.08]",
        className,
      )}
      {...props}
    />
  );
}

export function PanelSplitSeparator() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-border/65" />;
}

/** Trailing actions that appear on row hover/focus (and stay while their menu is open). */
export const ROW_HOVER_ACTION_CLASS =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100";
