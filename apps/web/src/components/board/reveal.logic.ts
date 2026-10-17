import type { Project } from "@repo/contracts";
import { STATUS_ORDER, type Lane } from "./board.logic";

/** How long a reveal request waits for the board to show its card before it is dropped. */
export const REVEAL_EXPIRY_MS = 5000;

/** What the board does next to bring a task into view. */
export type RevealStep =
  /** The card isn't on the board (a filter hides it, or it is archived): the panel opens and nothing moves. */
  | { kind: "hidden" }
  /** The task's lane is folded to its header. */
  | { kind: "expand-lane"; project: Project }
  /** The task sits in an epic band folded to its header. */
  | { kind: "expand-band"; epicId: string }
  /** The card is shown: scroll to it. */
  | { kind: "show" };

/**
 * The next step for revealing a task, given the lanes as filtered. A card in a collapsed column needs no step of its
 * own: the open task is always kept in view there. The epic's own header stays when its band is folded.
 */
export function revealStep(
  lanes: ReadonlyArray<Lane>,
  taskId: string,
  collapsedEpics: Readonly<Record<string, true>>,
): RevealStep {
  for (const lane of lanes) {
    if (lane.priority) {
      if (STATUS_ORDER.some((status) => lane.cells[status].some((task) => task.id === taskId))) return { kind: "show" };
      continue;
    }
    for (const band of lane.bands) {
      const inBand = band.id === taskId || STATUS_ORDER.some((s) => band.cells[s].some((task) => task.id === taskId));
      if (!inBand) continue;
      if (lane.project.collapsed) return { kind: "expand-lane", project: lane.project };
      return band.id !== taskId && collapsedEpics[band.id]
        ? { kind: "expand-band", epicId: band.id }
        : { kind: "show" };
    }
    const inLoose =
      STATUS_ORDER.some((status) => lane.cells[status].some((task) => task.id === taskId)) ||
      Object.values(lane.epicChildren).some((children) => children.some((task) => task.id === taskId));
    if (inLoose) return lane.project.collapsed ? { kind: "expand-lane", project: lane.project } : { kind: "show" };
  }
  return { kind: "hidden" };
}

export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface ScrollPosition {
  top: number;
  left: number;
}

function alignAxis(viewStart: number, viewEnd: number, cardStart: number, cardEnd: number, scroll: number): number {
  if (cardStart >= viewStart && cardEnd <= viewEnd) return scroll;
  // A card taller than the view starts at its edge, so its beginning isn't the part that is cut off.
  if (cardEnd - cardStart >= viewEnd - viewStart) return scroll + (cardStart - viewStart);
  return scroll + (cardStart + cardEnd) / 2 - (viewStart + viewEnd) / 2;
}

/**
 * Where to scroll the board so a card is in view: the card is centred on each axis it isn't fully visible on and
 * left alone on the other. `view` is the part of the scroll box the card can be seen in (below the sticky column
 * header), `card` its box; both in viewport coordinates, `scroll` the box's current position. Null when it is already
 * in view.
 */
export function revealScrollTarget(view: Box, card: Box, scroll: ScrollPosition): ScrollPosition | null {
  const top = alignAxis(view.top, view.bottom, card.top, card.bottom, scroll.top);
  const left = alignAxis(view.left, view.right, card.left, card.right, scroll.left);
  return top === scroll.top && left === scroll.left ? null : { top, left };
}
