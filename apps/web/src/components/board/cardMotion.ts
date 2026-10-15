import { defaultDropAnimationSideEffects, type DropAnimation } from "@dnd-kit/core";
import { useLayoutEffect, type RefObject } from "react";

/*
 * Card motion in one place: the drag overlay's drop, and the FLIP that slides a card back when a
 * move is rolled back. The lift is CSS (TaskCardOverlay, `animate-card-lift`). All of it is off
 * under prefers-reduced-motion.
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

// Where a card was just before its move was rolled back, so it can slide from there.
const flipFrom = new Map<string, { rect: DOMRect; at: number }>();
// A card that never mounts again (collapsed lane, truncated Done) must not animate much later.
const FLIP_TTL_MS = 500;

/**
 * Call right before writing a rollback to the cache. A rejection can arrive while the drop
 * animation is still landing; the card then slides back from the overlay, which hides so the
 * card isn't shown twice.
 */
export function captureCardRect(taskId: string) {
  const overlay = document.querySelector<HTMLElement>(".is-dropping");
  if (overlay) overlay.style.visibility = "hidden";
  if (prefersReducedMotion()) return;
  const node = overlay ?? document.querySelector(`[data-task-card="${CSS.escape(taskId)}"]`);
  if (node) flipFrom.set(taskId, { rect: node.getBoundingClientRect(), at: performance.now() });
}

/** Slides the card from its captured rect into wherever it renders now (FLIP). */
export function useCardFlip(taskId: string, nodeRef: RefObject<HTMLElement | null>, placementKey: string) {
  useLayoutEffect(() => {
    const from = flipFrom.get(taskId);
    const node = nodeRef.current;
    if (!from || !node) return;
    flipFrom.delete(taskId);
    if (performance.now() - from.at > FLIP_TTL_MS) return;
    const to = node.getBoundingClientRect();
    const dx = from.rect.left - to.left;
    const dy = from.rect.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: 260,
      easing: EASE_OUT,
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- placementKey is the trigger: the card moved
  }, [taskId, nodeRef, placementKey]);
}
