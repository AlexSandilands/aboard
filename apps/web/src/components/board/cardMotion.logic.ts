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

/** A snapshot nothing consumed (the write changed no card) must not animate a much later render. */
export const SNAPSHOT_TTL_MS = 300;

/** The board's scroll box when a snapshot was taken: rects are relative to its top left corner. */
export interface BoardView {
  width: number;
  height: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface CardSnapshot {
  rects: Map<string, CardRect>;
  at: number;
  view: BoardView;
}

/** Writes in one burst share the first snapshot; a stale one is replaced. */
export function canReuseSnapshot<T extends Pick<CardSnapshot, "at">>(pending: T | null, now: number): pending is T {
  return pending !== null && now - pending.at <= SNAPSHOT_TTL_MS;
}

/**
 * The snapshot's rects, moved to where they sit under the board's scroll position now, or null when
 * there is nothing to animate from: it is stale, empty (no board was showing), or the scroll box
 * itself resized (the task panel or sidebar sliding), which moves every card without moving any.
 */
export function settleSnapshot(
  snapshot: CardSnapshot,
  now: number,
  view: BoardView,
): ReadonlyMap<string, CardRect> | null {
  if (!canReuseSnapshot(snapshot, now) || snapshot.rects.size === 0) return null;
  if (
    Math.abs(view.width - snapshot.view.width) >= MIN_SHIFT_PX ||
    Math.abs(view.height - snapshot.view.height) >= MIN_SHIFT_PX
  )
    return null;
  const dx = snapshot.view.scrollLeft - view.scrollLeft;
  const dy = snapshot.view.scrollTop - view.scrollTop;
  return new Map([...snapshot.rects].map(([id, rect]) => [id, { ...rect, left: rect.left + dx, top: rect.top + dy }]));
}
