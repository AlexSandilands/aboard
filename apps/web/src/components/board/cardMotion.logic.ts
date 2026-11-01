export interface CardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type CardMotion = { id: string; kind: "slide"; dx: number; dy: number } | { id: string; kind: "fade" };

/** Panel animations scaled so the 150 ms default gives about the 260 ms the rollback slide always had. */
const FLIP_SCALE = 1.75;
/** Sub-pixel differences are layout rounding, not a move. */
const MIN_SHIFT_PX = 1;

/** How long a card slide takes for a Panel animations setting of `panelAnimationMs`; 0 is off. */
export function flipDurationMs(panelAnimationMs: number): number {
  return panelAnimationMs > 0 ? Math.round(panelAnimationMs * FLIP_SCALE) : 0;
}

function inView(rect: CardRect, viewport: { width: number; height: number }): boolean {
  return (
    rect.left < viewport.width && rect.left + rect.width > 0 && rect.top < viewport.height && rect.top + rect.height > 0
  );
}

/**
 * Which cards move between two snapshots of the board: a card that has a rect in both slides from
 * where it was; one with no previous rect fades in; one with no new rect (collapsed, filtered out,
 * gone) isn't in `next` and is skipped. Cards that are off screen both before and after stay still.
 */
export function planCardMotion(
  prev: ReadonlyMap<string, CardRect>,
  next: ReadonlyMap<string, CardRect>,
  viewport: { width: number; height: number },
): CardMotion[] {
  const motions: CardMotion[] = [];
  for (const [id, to] of next) {
    const from = prev.get(id);
    if (!from) {
      if (inView(to, viewport)) motions.push({ id, kind: "fade" });
      continue;
    }
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < MIN_SHIFT_PX && Math.abs(dy) < MIN_SHIFT_PX) continue;
    if (!inView(from, viewport) && !inView(to, viewport)) continue;
    motions.push({ id, kind: "slide", dx, dy });
  }
  return motions;
}
