/*
 * How the desktop sidebar slides. The gap beside it changes width at once, so the main area lays out once at its
 * final width instead of on every frame. The sidebar then moves with a transform, and the main area glides from where
 * it was to where it now sits, in step with it.
 */

/**
 * The slide runs this many times the Panel animations setting: 150 ms gives 450 ms, in the 400 to 470 ms
 * range fitted from a recording of Antigravity's panel opening. The curve fitted from it is `--ease-sidebar-slide`
 * in index.css.
 */
export const SLIDE_SCALE = 3;

/** How long the slide takes for a Panel animations setting of `panelAnimationMs`; 0 is off. */
export function slideDurationMs(panelAnimationMs: number): number {
  return panelAnimationMs > 0 ? Math.round(panelAnimationMs * SLIDE_SCALE) : 0;
}

/**
 * Where the main area's glide starts, as a translateX in px. Opening a left sidebar pushes the main area's left edge
 * `width` to the right, so it starts `width` to the left of where it now sits; closing starts `width` to the right.
 * A right sidebar mirrors that. `current` is the offset of a glide still running (0 when none), which the new one
 * continues from so a fast second toggle doesn't jump.
 */
export function glideStartOffset(input: {
  current: number;
  width: number;
  opening: boolean;
  side: "left" | "right";
}): number {
  const towardSidebar = input.side === "left" ? -1 : 1;
  return input.current + (input.opening ? towardSidebar : -towardSidebar) * input.width;
}

/**
 * How long a glide that starts `from` px from rest runs. A reversal mid-slide restarts the sidebar's CSS transition with
 * its duration scaled by the share of the distance still to cover; the glide gets the same, so both finish together.
 */
export function glideDurationMs(durationMs: number, from: number, width: number): number {
  return width > 0 ? durationMs * Math.min(1, Math.abs(from) / width) : durationMs;
}
