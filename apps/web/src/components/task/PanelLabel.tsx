import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

import { labelPan } from "./labelPan.logic";
import { PANEL_LABEL_CLASS } from "./PanelControl";

function startPan(el: HTMLElement) {
  // Clear first so a label that no longer overflows doesn't keep an earlier animation.
  stopPan(el);
  const pan = labelPan(el.scrollWidth, el.clientWidth);
  if (!pan) return;
  // Straight on the element: a render per hover would buy nothing, the animation lives in CSS.
  el.style.setProperty("--label-pan-distance", `${pan.distancePx}px`);
  el.style.setProperty("--label-pan-duration", `${pan.cycleMs}ms`);
  el.dataset.labelPanning = "";
}

function stopPan(el: HTMLElement) {
  delete el.dataset.labelPanning;
}

/**
 * A single-line label that ellipsizes. While hovered and truncated it pans to show its end (`label-pan` in
 * index.css; off under prefers-reduced-motion). The full text should be in the enclosing row's `title`.
 */
export function PanelLabel({ className, onPointerEnter, onPointerLeave, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(PANEL_LABEL_CLASS, className)}
      onPointerEnter={(e) => {
        startPan(e.currentTarget);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        stopPan(e.currentTarget);
        onPointerLeave?.(e);
      }}
      {...props}
    />
  );
}
