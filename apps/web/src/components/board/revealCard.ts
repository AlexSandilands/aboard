import { revealScrollTarget } from "./reveal.logic";

/** Longest a smooth scroll is waited on before the card flashes anyway (browsers without `scrollend`). */
const SCROLL_SETTLE_MS = 1200;

/**
 * Scrolls the board's scroll box to a card (smoothly, or at once under reduced motion), then flashes a ring round it.
 * `header` is the sticky column header, which hides the top of the box.
 */
export function revealCard(scroller: HTMLElement, header: HTMLElement | null, card: Element): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const align = (behavior: ScrollBehavior): boolean => {
    const box = scroller.getBoundingClientRect();
    const view = {
      top: box.top + (header?.offsetHeight ?? 0),
      left: box.left,
      bottom: box.top + scroller.clientHeight,
      right: box.left + scroller.clientWidth,
    };
    const target = revealScrollTarget(view, card.getBoundingClientRect(), {
      top: scroller.scrollTop,
      left: scroller.scrollLeft,
    });
    if (!target) return false;
    // The box clamps to its ends: a scroll it can't make fires no `scrollend`, so don't wait for one.
    const top = Math.min(Math.max(target.top, 0), scroller.scrollHeight - scroller.clientHeight);
    const left = Math.min(Math.max(target.left, 0), scroller.scrollWidth - scroller.clientWidth);
    if (Math.abs(top - scroller.scrollTop) < 1 && Math.abs(left - scroller.scrollLeft) < 1) return false;
    scroller.scrollTo({ top, left, behavior });
    return true;
  };

  if (reduceMotion) {
    align("instant");
    flash(card, true);
    return;
  }
  if (!align("smooth")) {
    flash(card, false);
    return;
  }
  // Flash once the card has arrived. Cards off screen are laid out at an estimated height, and the panel may still
  // be docking, so the first aim can fall a little short: one correction after it settles.
  whenScrollSettled(scroller, () => {
    // An update can remove the card meanwhile (it moved row, was archived, its lane folded).
    if (!card.isConnected) return;
    if (align("smooth")) whenScrollSettled(scroller, () => flash(card, false));
    else flash(card, false);
  });
}

/** Calls `done` once the box has stopped scrolling, or after a moment where `scrollend` doesn't exist or never comes. */
function whenScrollSettled(scroller: HTMLElement, done: () => void): void {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    scroller.removeEventListener("scrollend", settle);
    window.clearTimeout(timer);
    done();
  };
  const timer = window.setTimeout(settle, SCROLL_SETTLE_MS);
  scroller.addEventListener("scrollend", settle);
}

/**
 * A ring that fades out. Drawn with the Web Animations API rather than a class, which React would drop whenever the
 * card re-renders. Under reduced motion it holds and ends without a fade.
 */
function flash(card: Element, reduceMotion: boolean): void {
  const ring = "0 0 0 2px var(--color-ring)";
  const keyframes: Keyframe[] = reduceMotion
    ? [{ boxShadow: ring }, { boxShadow: ring }]
    : [
        { boxShadow: ring, offset: 0 },
        { boxShadow: ring, offset: 0.35 },
        { boxShadow: "0 0 0 2px transparent", offset: 1 },
      ];
  card.animate(keyframes, { duration: reduceMotion ? 1200 : 1600, easing: "ease-out" });
}
