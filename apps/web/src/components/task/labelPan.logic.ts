/** Pan speed: slow enough to read the text as it slides. */
const PAN_PX_PER_SECOND = 80;
/** The keyframes (`label-pan` in index.css) spend this share of the cycle moving; the rest is the pauses. */
const PAN_SHARE_OF_CYCLE = 0.6;
const MIN_CYCLE_MS = 1500;
const MAX_CYCLE_MS = 12000;

export interface LabelPan {
  /** Pixels the text shifts left to bring its end into view (the hidden width plus a pixel of slack). */
  distancePx: number;
  /** One cycle of the animation: pan, pause at the end, jump back, pause at the start. */
  cycleMs: number;
}

/** How far a label's text overflows its box, or null when it fits (nothing to reveal). */
export function labelPan(scrollWidth: number, clientWidth: number): LabelPan | null {
  // Both widths are rounded to whole pixels, so an overflow under 1px reads as none.
  const overflow = scrollWidth - clientWidth;
  if (overflow < 1) return null;
  // One pixel past the end: if the true overflow is fractional, stopping short would leave the ellipsis over the last glyph.
  const distancePx = overflow + 1;
  const panMs = (distancePx / PAN_PX_PER_SECOND) * 1000;
  const cycleMs = Math.min(MAX_CYCLE_MS, Math.max(MIN_CYCLE_MS, panMs / PAN_SHARE_OF_CYCLE));
  return { distancePx, cycleMs };
}
