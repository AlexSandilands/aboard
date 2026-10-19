/** What the sentinel observer reports: whether it is on screen and where it sits against the visible area. */
export interface SentinelReading {
  isIntersecting: boolean;
  /** The sentinel's top edge, and the visible area's (the scroll box under the column header). */
  top: number;
  rootTop: number;
}

/**
 * Whether a pinned lane is stuck: its sentinel, which sits where the lane would be unpinned, has scrolled up past the
 * column header. A sentinel below the visible area (the lane is where it belongs, just off screen) isn't stuck.
 */
export function isStuck({ isIntersecting, top, rootTop }: SentinelReading): boolean {
  return !isIntersecting && top < rootTop;
}
