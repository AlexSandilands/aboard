/**
 * The height of a pinned lane scrolled `scrolled` pixels past the column header, or null while it hasn't been (it
 * isn't stuck). It gives up one pixel per pixel scrolled, so its bottom stays on the lanes under it, which keep their
 * place because a spacer takes up what it gave up; it stops at `settled` (the chosen height, or its one-line cards if
 * they take less) and never grows past its full height.
 */
export function stuckHeight({
  natural,
  scrolled,
  settled,
}: {
  /** The lane's full height, as last seen unstuck. */
  natural: number;
  scrolled: number;
  settled: number;
}): number | null {
  return scrolled > 0 ? Math.max(natural - scrolled, Math.min(natural, settled)) : null;
}
