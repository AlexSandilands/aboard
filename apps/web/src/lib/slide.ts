import { SLIDE_EASING, slideDurationForDistance } from "./slide.logic";

/*
 * How the sidebar and the task panel slide (useSidebarSlide, usePanelSlide), in one place. Two animations share one
 * clock and curve: `room`, the width of the space beside them, which the main area lays out around every frame so the
 * board moves with them; and `mover`, the sidebar or panel itself, on a transform the compositor runs, so a busy main
 * thread holds the board up for a frame but not the slide.
 */

const SLIDE_ID = "slide";

/** The slide's length in ms from the Panel animations setting; 0 when it is off or motion is reduced. */
export function slideDuration(): number {
  const root = document.documentElement;
  if (root.dataset.panelAnimations !== "true") return 0;
  return Number.parseFloat(root.style.getPropertyValue("--slide-duration")) || 0;
}

/** Slides on these elements, running or held. */
export function slidesOn(...elements: Element[]): Animation[] {
  return elements.flatMap((element) => element.getAnimations().filter((animation) => animation.id === SLIDE_ID));
}

/** The translateX a slide has `element` at right now (0 when none). */
export function slideOffset(element: Element): number {
  return new DOMMatrix(getComputedStyle(element).transform).m41;
}

/**
 * Starts a slide of `mover` from `from` to `to` px (translateX) and of `room`'s width between `roomFrom` and `roomTo`,
 * cancelling any slide already on them. Over `width` px the slide takes `duration`; a shorter turn back takes its share.
 *
 * From rest it holds its first frame and starts the clock two frames later. That frame carries React's work for the
 * toggle, and the first rAF after it runs at its end with its start as the timeline's time: a start time taken there
 * would put the slide as far along as the work took, skipping the fast start of the curve. A slide already moving
 * turns around at once. One held in place (StrictMode runs layout effects twice) counts as at rest.
 */
export function startSlide(input: {
  mover: HTMLElement;
  room: HTMLElement;
  from: number;
  to: number;
  roomFrom: number;
  roomTo: number;
  width: number;
  duration: number;
  /** Keep the end state until the caller removes the element (a closing panel). */
  fill?: boolean;
}): { slide: Animation } {
  const running = slidesOn(input.mover, input.room);
  const moving = running.some((animation) => animation.playState === "running");
  for (const animation of running) animation.cancel();
  const timing: KeyframeAnimationOptions = {
    duration: slideDurationForDistance(input.duration, input.to - input.from, input.width),
    easing: SLIDE_EASING,
    fill: input.fill ? "forwards" : "none",
    id: SLIDE_ID,
  };
  input.mover.style.willChange = "transform";
  const slide = input.mover.animate(
    [{ transform: `translateX(${input.from}px)` }, { transform: `translateX(${input.to}px)` }],
    timing,
  );
  const room = input.room.animate([{ width: `${input.roomFrom}px` }, { width: `${input.roomTo}px` }], timing);
  slide.addEventListener("finish", () => {
    input.mover.style.willChange = "";
  });
  const start = () => {
    // One start time, so the board and the slide can't drift apart by a frame.
    const now = document.timeline.currentTime;
    for (const animation of [slide, room]) {
      animation.play();
      animation.startTime = now;
    }
  };
  if (moving) {
    start();
  } else {
    slide.pause();
    room.pause();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (slide.playState === "paused") start();
      }),
    );
  }
  return { slide };
}

/**
 * Ends every slide at once. A card drag measures the board's columns as it starts and a resize drag writes the width a
 * slide is animating, so both finish a slide first.
 */
export function finishSlides() {
  for (const animation of document.getAnimations()) if (animation.id === SLIDE_ID) animation.finish();
}
