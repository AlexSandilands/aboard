/** What opensFromHeader needs of a click's target: a DOM Element has both. */
export interface HeaderClickTarget {
  closest(selector: string): unknown;
}

/** The band header's own controls, which do their own thing (the title button opens the epic itself). */
const HEADER_CONTROLS = "button, a, input, [role='button'], [role='menuitem']";

/**
 * Whether a click on an epic band's header should open the epic: one on its background or text, not on one of its
 * own controls (chevron, badge, links, hand-off, Autopilot), and not one that bubbled through React from a popup they
 * portal out of the header, which isn't inside it in the DOM.
 */
export function opensFromHeader(
  target: Partial<HeaderClickTarget> | null,
  header: { contains(node: never): boolean },
): boolean {
  if (!target || typeof target.closest !== "function" || !header.contains(target as never)) return false;
  return !target.closest(HEADER_CONTROLS);
}
