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

/**
 * Why an explicit jump found no card. `number` is the task's number when it is in the board snapshot: its card is
 * then on the board unless the filters hide it. Otherwise the task may be archived (shown only by Show archived) or
 * not loaded yet, so the message doesn't claim which.
 */
export function revealHiddenMessage(number: number | undefined): string {
  return number === undefined
    ? "This task isn't on the board. Archived tasks only show when Show archived is on."
    : `The filters hide #${number}.`;
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

/**
 * How far down the scroll box a card can be seen from, in viewport coordinates: below the sticky column header, and
 * below the pinned priority lane too when it is there (`laneBottom`, null when the lane isn't pinned or the card is in
 * it). The lane sits over the project lanes, so a card scrolled under it counts as hidden.
 */
export function visibleFrom(boxTop: number, headerHeight: number, laneBottom: number | null): number {
  return Math.max(boxTop + headerHeight, laneBottom ?? 0);
}

/** What the board does with an open reveal request on this pass. */
export type RevealAction =
  /** Nothing yet: the task isn't the open one, or its card isn't drawn; the next change tries again. */
  | { kind: "wait" }
  /** The request is finished without a scroll: it expired, or the card isn't on the board (a filter, or archived). */
  | { kind: "drop"; reason: "expired" | "hidden" }
  | { kind: "expand-lane"; project: Project }
  | { kind: "expand-band"; epicId: string }
  | { kind: "scroll" };

/** What the board has done for the open reveal request: the lanes and bands it already expanded. */
export interface RevealProgress {
  nonce: number;
  expanded: Set<string>;
}

/** The progress for a request: the previous one while it is the same request, a fresh one for a new nonce. */
export function revealProgressFor(previous: RevealProgress | null, nonce: number): RevealProgress {
  return previous?.nonce === nonce ? previous : { nonce, expanded: new Set() };
}

/**
 * The next action for a reveal request. `expanded` holds the lanes and bands already expanded for it, so a refused
 * update can't loop; the caller adds to it when it acts. `cardDrawn` is whether the card is in the DOM.
 */
export function advanceReveal(input: {
  taskId: string;
  /** Milliseconds since the request was made. */
  age: number;
  lanes: ReadonlyArray<Lane>;
  collapsedEpics: Readonly<Record<string, true>>;
  expanded: ReadonlySet<string>;
  selectedTaskId: string | null;
  cardDrawn: () => boolean;
}): RevealAction {
  if (input.age > REVEAL_EXPIRY_MS) return { kind: "drop", reason: "expired" };
  const step = revealStep(input.lanes, input.taskId, input.collapsedEpics);
  if (step.kind === "hidden") return { kind: "drop", reason: "hidden" };
  if (step.kind === "expand-lane") {
    return input.expanded.has(step.project.id) ? { kind: "wait" } : step;
  }
  if (step.kind === "expand-band") return input.expanded.has(step.epicId) ? { kind: "wait" } : step;
  // The open task keeps its card in a collapsed column, so wait until it is the open one.
  if (input.selectedTaskId !== input.taskId || !input.cardDrawn()) return { kind: "wait" };
  return { kind: "scroll" };
}
