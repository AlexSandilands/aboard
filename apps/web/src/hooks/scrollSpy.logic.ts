/** How far below the top of the scroll area a section's heading may sit and still count as the one being read. */
export const SPY_THRESHOLD_PX = 96;

/**
 * Scroll-spy: the section being read, given each section's top relative to the top of the visible scroll area, in
 * page order. It is the last one whose top has reached the threshold; before any has, the first. Scrolled to the
 * bottom, it is the last one, which may be too short ever to reach the threshold.
 */
export function activeSectionId(
  sections: ReadonlyArray<{ id: string; top: number }>,
  { atBottom, threshold = SPY_THRESHOLD_PX }: { atBottom: boolean; threshold?: number },
): string | null {
  if (sections.length === 0) return null;
  if (atBottom) return sections.at(-1)!.id;
  let active = sections[0]!.id;
  for (const entry of sections) {
    if (entry.top <= threshold) active = entry.id;
    else break;
  }
  return active;
}

/** Whether a scroll area is scrolled to its end. One that can't scroll at all isn't: its first section is read. */
export function isScrolledToBottom(area: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return area.scrollTop > 0 && area.scrollTop + area.clientHeight >= area.scrollHeight - 2;
}
