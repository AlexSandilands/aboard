/** Which edges of a sideways-scrolling box hide more content, for the fades on a wide Markdown table. */
export type MoreSide = "left" | "right" | "both";

/** A pixel of slack, since scroll positions are fractional on zoomed or high-DPI screens. */
const SLACK = 1;

export function moreSide(box: { scrollLeft: number; clientWidth: number; scrollWidth: number }): MoreSide | undefined {
  const left = box.scrollLeft > SLACK;
  const right = box.scrollLeft + box.clientWidth < box.scrollWidth - SLACK;
  return left && right ? "both" : left ? "left" : right ? "right" : undefined;
}
