import { defaultDropAnimationSideEffects, type DropAnimation } from "@dnd-kit/core";
import { useLayoutEffect } from "react";
import { flipDurationMs, planCardMotion, type CardRect } from "./cardMotion.logic";

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
// A snapshot nothing consumed (the write changed no card) must not animate a much later render.
const SNAPSHOT_TTL_MS = 300;

let pending: { rects: Map<string, CardRect>; at: number } | null = null;

/** How long a card slide takes: follows Settings, Appearance, Panel animations; 0 when those are off. */
function flipDuration(): number {
  const root = document.documentElement;
  if (root.dataset.panelAnimations !== "true" || prefersReducedMotion()) return 0;
  return flipDurationMs(Number.parseFloat(root.style.getPropertyValue("--panel-animation-duration")) || 0);
}

function readCards(): Map<string, { node: HTMLElement; rect: CardRect }> {
  const cards = new Map<string, { node: HTMLElement; rect: CardRect }>();
  const duplicated = new Set<string>();
  for (const node of document.querySelectorAll<HTMLElement>("[data-task-card]")) {
    const id = node.dataset.taskCard;
    if (!id) continue;
    if (cards.has(id)) duplicated.add(id);
    const { left, top, width, height } = node.getBoundingClientRect();
    if (width > 0 && height > 0) cards.set(id, { node, rect: { left, top, width, height } });
  }
  // A card drawn twice has no single place to slide from.
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
  if (flipDuration() === 0 || (!rolledBackId && isDragging())) return;
  const now = performance.now();
  if (!pending || now - pending.at > SNAPSHOT_TTL_MS) {
    pending = { rects: new Map([...readCards()].map(([id, card]) => [id, card.rect])), at: now };
  }
  if (rolledBackId) {
    const from = (
      overlay ?? document.querySelector(`[data-task-card="${CSS.escape(rolledBackId)}"]`)
    )?.getBoundingClientRect();
    if (from) pending.rects.set(rolledBackId, from);
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
    if (!snapshot || performance.now() - snapshot.at > SNAPSHOT_TTL_MS) return;
    const duration = flipDuration();
    if (duration === 0) return;
    // A slide still running would make the new rects read as mid-flight.
    for (const animation of document.getAnimations()) if (animation.id === FLIP_ANIMATION_ID) animation.cancel();
    const cards = readCards();
    const next = new Map([...cards].map(([id, card]) => [id, card.rect]));
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    for (const motion of planCardMotion(snapshot.rects, next, viewport)) {
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
}
