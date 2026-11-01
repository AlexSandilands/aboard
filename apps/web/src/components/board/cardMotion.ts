import { defaultDropAnimationSideEffects, type DropAnimation } from "@dnd-kit/core";
import { useLayoutEffect } from "react";
import {
  canReuseSnapshot,
  flipDurationMs,
  planCardMotion,
  settleSnapshot,
  type BoardView,
  type CardRect,
  type CardSnapshot,
} from "./cardMotion.logic";

/*
 * Card motion in one place: the drag overlay's drop, and a board-level FLIP that slides every card
 * whose place changed (the moved one and the neighbours closing the gap), fades new ones in and
 * slides a rolled-back card back. The lift is CSS (TaskCardOverlay, `animate-card-lift`). All of it
 * is off under prefers-reduced-motion.
 */

const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The overlay settles into the card's slot, which the drag preview has already moved to the
 * target column. `is-dropping` lets the overlay shed its lift while it lands.
 */
export function dropAnimation(): DropAnimation | null {
  if (prefersReducedMotion()) return null;
  return {
    duration: 200,
    easing: EASE_OUT,
    sideEffects: defaultDropAnimationSideEffects({
      styles: { active: { opacity: "0" } },
      className: { dragOverlay: "is-dropping" },
    }),
  };
}

const FLIP_ANIMATION_ID = "card-flip";

let pending: CardSnapshot | null = null;

/** How long a card slide takes: follows Settings, Appearance, Panel animations; 0 when those are off. */
function flipDuration(): number {
  const root = document.documentElement;
  if (root.dataset.panelAnimations !== "true" || prefersReducedMotion()) return 0;
  return flipDurationMs(Number.parseFloat(root.style.getPropertyValue("--panel-animation-duration")) || 0);
}

function boardScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-board-scroll]");
}

function boardView(scroller: HTMLElement): BoardView {
  return {
    width: scroller.clientWidth,
    height: scroller.clientHeight,
    scrollLeft: scroller.scrollLeft,
    scrollTop: scroller.scrollTop,
  };
}

/** A rect relative to the board's scroll box, so the panel opening or the sidebar sliding isn't a card move. */
function relativeRect(rect: DOMRect, scroller: HTMLElement): CardRect {
  const box = scroller.getBoundingClientRect();
  return { left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height };
}

function readCards(scroller: HTMLElement): Map<string, { node: HTMLElement; rect: CardRect }> {
  const cards = new Map<string, { node: HTMLElement; rect: CardRect }>();
  const duplicated = new Set<string>();
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-task-card]")) {
    const id = node.dataset.taskCard;
    if (!id) continue;
    const bounds = node.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    // A card drawn twice (say an epic's child row beside its own card) has no single place to slide from.
    if (cards.has(id)) duplicated.add(id);
    cards.set(id, { node, rect: relativeRect(bounds, scroller) });
  }
  for (const id of duplicated) cards.delete(id);
  return cards;
}

/** A card is lifted while its overlay is on screen and not yet landing. */
function isDragging(): boolean {
  return document.querySelector("[data-card-overlay]") !== null && document.querySelector(".is-dropping") === null;
}

/**
 * Call right before writing to the board cache anything that can move cards (an event, an
 * optimistic move). Remembers where the visible cards are so `useBoardFlip` can slide them from
 * there once the board commits. Writes in the same burst share the first snapshot, so nothing
 * animates twice. Does nothing while a card is being dragged (the drop animation lands it).
 *
 * `rolledBackId` is a card whose move is being rolled back: a rejection can arrive while the drop
 * animation is still landing, so the card slides back from the overlay, which hides so the card
 * isn't shown twice.
 */
export function snapshotCardRects(rolledBackId?: string) {
  const overlay = rolledBackId ? document.querySelector<HTMLElement>(".is-dropping") : null;
  if (overlay) overlay.style.visibility = "hidden";
  const scroller = boardScroller();
  if (!scroller || document.hidden || flipDuration() === 0 || (!rolledBackId && isDragging())) return;
  const now = performance.now();
  const snapshot = canReuseSnapshot(pending, now)
    ? pending
    : {
        rects: new Map([...readCards(scroller)].map(([id, card]) => [id, card.rect])),
        at: now,
        view: boardView(scroller),
      };
  pending = snapshot;
  if (rolledBackId) {
    const from = (
      overlay ?? scroller.querySelector(`[data-task-card="${CSS.escape(rolledBackId)}"]`)
    )?.getBoundingClientRect();
    if (from) snapshot.rects.set(rolledBackId, relativeRect(from, scroller));
  }
}

/**
 * Animates the cards that moved since `snapshotCardRects` (FLIP): transform and opacity only, over
 * the Panel animations duration. Call it with the board data, so it runs in the commit that
 * renders it.
 */
export function useBoardFlip(board: unknown) {
  useLayoutEffect(() => {
    const snapshot = pending;
    pending = null;
    const scroller = boardScroller();
    if (!snapshot || !scroller) return;
    const duration = flipDuration();
    if (duration === 0) return;
    const from = settleSnapshot(snapshot, performance.now(), boardView(scroller));
    if (!from) return;
    // A slide still running would make the new rects read as mid-flight.
    for (const animation of document.getAnimations()) if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
    const cards = readCards(scroller);
    const next = new Map([...cards].map(([id, card]) => [id, card.rect]));
    const viewport = { width: scroller.clientWidth, height: scroller.clientHeight };
    for (const motion of planCardMotion(from, next, viewport)) {
      const node = cards.get(motion.id)?.node;
      if (!node) continue;
      const keyframes =
        motion.kind === "slide"
          ? [{ transform: `translate(${motion.dx}px, ${motion.dy}px)` }, { transform: "none" }]
          : [{ opacity: 0 }, { opacity: 1 }];
      node.animate(keyframes, { duration, easing: EASE_OUT, id: FLIP_ANIMATION_ID });
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- board is the trigger: it just committed
  }, [board]);
  // A snapshot taken while no board is mounted must not fade a board in that mounts a moment later.
  useLayoutEffect(
    () => () => {
      pending = null;
    },
    [],
  );
}
