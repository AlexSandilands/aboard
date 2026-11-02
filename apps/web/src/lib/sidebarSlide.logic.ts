/*
 * How the desktop sidebar and the task panel slide: the space beside them changes width every frame, so the main area
 * moves with them, while the sidebar or panel itself moves with a transform.
 */

/**
 * The slide runs this many times the Panel animations setting: 150 ms gives 450 ms, in the 400 to 470 ms
 * range fitted from a recording of Antigravity's right-hand panel opening.
 */
export const SLIDE_SCALE = 3;

/** The slide's curve, fitted frame by frame from the same recording: a fast start and a long, soft tail. */
export const SLIDE_EASING = "cubic-bezier(0.2, 0.9, 0.25, 1)";

/** How long the slide takes for a Panel animations setting of `panelAnimationMs`; 0 is off. */
export function slideDurationMs(panelAnimationMs: number): number {
  return panelAnimationMs > 0 ? Math.round(panelAnimationMs * SLIDE_SCALE) : 0;
}

/**
 * Where the sidebar's slide starts, as a translateX in px from where it now rests. Opening a left sidebar starts it
 * `width` to the left; closing starts it `width` to the right of its new, hidden place. A right sidebar mirrors that.
 * `current` is the offset of a slide still running (0 when none), which the new one continues from so a fast second
 * toggle doesn't jump.
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

/** How long a slide that starts `from` px from rest runs: the share of the full duration for the distance left. */
export function glideDurationMs(durationMs: number, from: number, width: number): number {
  return width > 0 ? durationMs * Math.min(1, Math.abs(from) / width) : durationMs;
}

/** How wide the gap beside the sidebar is when a slide starts `from` px from rest: the part of the sidebar on screen. */
export function gapStartWidth(input: { from: number; width: number; opening: boolean }): number {
  const hidden = Math.min(input.width, Math.abs(input.from));
  return input.opening ? input.width - hidden : hidden;
}
