/*
 * Smooth board motion (Appearance → Motion): the task panel and the sidebar open and close as a View Transition instead
 * of `startSlide` (lib/slide.ts). The board is laid out once, at its new width, and the compositor moves snapshots of
 * what is on screen from their old boxes to their new ones. The router starts the panel's transition (router.tsx),
 * `startSidebarTransition` the sidebar's, and index.css styles them.
 */

/**
 * Whether the browser has what snapshot motion uses: transition types (the router ignores `types` without them and
 * would animate every navigation, and index.css tells opening from closing by them), `match-element` names, and
 * `document.activeViewTransition`, which is how prepareBoardTransition finds the router's transition.
 */
export function snapshotMotionSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    "activeViewTransition" in document &&
    CSS.supports("selector(:active-view-transition-type(a))") &&
    CSS.supports("view-transition-name: match-element")
  );
}

/** Whether the panel and the sidebar move with snapshot motion now. Off with Panel animations, so reduced motion too. */
export function boardSnapshotMotion(): boolean {
  const root = document.documentElement;
  return (
    root.dataset.panelAnimations === "true" && root.dataset.boardMotion === "snapshot" && snapshotMotionSupported()
  );
}

/**
 * Whether the sidebar moves with snapshot motion now: only over the board, which is what the snapshots are of. On any
 * other page nothing is named, so a transition would hold the main area at its old layout for the whole slide and then
 * jump; there the sidebar slides with `startSlide` and the page reflows around it. Both `startSidebarTransition` and
 * `useSidebarSlide` ask this, so the transition and the slide can't disagree.
 */
export function sidebarSnapshotMotion(): boolean {
  return boardSnapshotMotion() && document.querySelector("[data-board-scroll]") !== null;
}

/**
 * Opens or closes the sidebar in a View Transition, `update` applying the change. Returns false, doing nothing, when
 * the sidebar doesn't move with snapshot motion (see sidebarSnapshotMotion).
 */
export function startSidebarTransition(opening: boolean, update: () => void): boolean {
  if (!sidebarSnapshotMotion()) return false;
  prepareBoardTransition("sidebar");
  document.startViewTransition({ update, types: [opening ? "sidebar-open" : "sidebar-close"] });
  return true;
}

/**
 * What moves on its own. Frames (`data-vt-frame`: an epic band's border and fill, its header's) stretch instead: their
 * right edge moves while the left stays, which a snapshot that only moves can't do. What they hold is named on its own,
 * so only the box stretches.
 */
const MOVERS = "[data-task-card], [data-epic-card], [data-vt-move], [data-vt-frame]";
/** What only moves when the board's left edge does (lane titles, the top bar's left side): named for the sidebar only. */
const LEFT_EDGE = "[data-vt-left]";
/** Frames get names of their own, so `compositorOnly` can tell their animations apart and stretch them. */
const FRAME_NAME = "vt-frame-";
/**
 * Cards change width when the sidebar opens or closes (with the panel closed), and a card that only moved sat at its new
 * width from the first frame: its right edge jumped, then glided. In a sidebar transition they stretch instead, under
 * names of their own, with a `scaleX` that `compositorOnly` turns their width animation into. Only cards: other movers
 * (a column header, an epic title) have no box of their own to stretch, only text, which would stretch with it.
 */
const CARDS = "[data-task-card], [data-epic-card]";
const STRETCH_NAME = "vt-stretch-";

/** Input that hurries a board transition to its end. */
const HURRY_EVENTS = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
/** How long a hurried transition takes to finish. */
const HURRY_MS = 120;

/** What the latest transition named. A transition started over a running one takes them over (see unname). */
let named: HTMLElement[] = [];
/** Whether a board transition is running, from prepareBoardTransition until the latest one finishes. */
let running = false;

/**
 * Whether the panel's or the sidebar's change is happening inside a board transition, which moves it, so its own slide
 * should stand down. False when the router skipped the transition (a task opened from another page, or on load):
 * then the panel slides in as without snapshot motion.
 */
export function boardTransitionRunning(): boolean {
  return running;
}

function unname(elements: HTMLElement[]) {
  for (const element of elements) {
    element.removeAttribute("data-vt");
    element.removeAttribute("data-vt-stretch");
    element.style.viewTransitionName = "";
  }
}

/**
 * Called right before a board View Transition starts, so before the old state is captured. Names only what is on
 * screen: every name is a snapshot to capture and animate, and Chromium's setup grows with the square of them (on a full
 * board 75 took about 90 ms, 140 about 1.3 s). Once the animations exist, makes them transform-only, starts them
 * together and lets input hurry them to their end.
 */
export function prepareBoardTransition(kind: "panel" | "sidebar") {
  // A transition started over a running one skips it, and the skipped one finishing must not unname what this one
  // names: it only unnames its own when it was the latest.
  unname(named);
  const mine: HTMLElement[] = [];
  named = mine;
  running = true;
  const { innerWidth: width, innerHeight: height } = window;
  const selector = kind === "sidebar" ? `${MOVERS}, ${LEFT_EDGE}` : MOVERS;
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.bottom <= 0 || box.top >= height || box.right <= 0 || box.left >= width) continue;
    element.setAttribute("data-vt", "");
    if (element.hasAttribute("data-vt-frame")) element.style.viewTransitionName = `${FRAME_NAME}${mine.length}`;
    else if (kind === "sidebar" && element.matches(CARDS)) {
      element.setAttribute("data-vt-stretch", "");
      element.style.viewTransitionName = `${STRETCH_NAME}${mine.length}`;
    }
    mine.push(element);
  }
  const release = () => {
    if (named !== mine) return;
    unname(mine);
    named = [];
    running = false;
  };
  // Both callers start the transition right after this, synchronously.
  queueMicrotask(() => {
    const transition = document.activeViewTransition;
    if (!transition) return release();
    // A skipped transition rejects `ready`; there is nothing to animate then.
    transition.ready.then(
      () => animate(transition),
      () => {},
    );
    void transition.finished.finally(release);
  });
}

function animate(transition: ViewTransition) {
  const animations = document.getAnimations().filter((animation) => {
    const effect = animation.effect;
    return effect instanceof KeyframeEffect && effect.pseudoElement?.startsWith("::view-transition") === true;
  });
  compositorOnly(animations);
  const start = holdFirstFrame(animations);
  // While it runs the page shows snapshots, so a scroll (or a click) would move the live board unseen until the end.
  // The first one hurries the transition to its end instead, and the board takes the input from there.
  const hurry = () => {
    stopListening();
    start();
    hurryToEnd(animations);
  };
  const stopListening = () => {
    for (const type of HURRY_EVENTS) window.removeEventListener(type, hurry, { capture: true });
  };
  for (const type of HURRY_EVENTS) window.addEventListener(type, hurry, { capture: true, passive: true });
  void transition.finished.finally(stopListening);
}

/**
 * The browser animates each snapshot's width and height as well as its transform, and width and height run on the main
 * thread: with dozens of cards that restyles every snapshot every frame, slower than laying the board out. Keeping only
 * the transform lets the compositor run it; the groups keep their new size and clip their snapshots (index.css).
 *
 * What stretches (frames, and cards in a sidebar transition) stretches as a transform too: the group sits at its new
 * size and a scale from old size over new to 1, from its top left corner (index.css), takes the place of the size
 * animation. Frames scale in both directions, since an epic band's height can change; cards only in width, since their
 * height is clipped. Animating the size itself left those groups on the main thread, and their edges stuttered while
 * everything around them glided.
 */
function compositorOnly(animations: Animation[]) {
  // Every keyframe read first, then every write: a read after a write restyles every snapshot again, which made this
  // quadratic.
  const rewrites: Array<[KeyframeEffect, Keyframe[]]> = [];
  for (const animation of animations) {
    const effect = animation.effect as KeyframeEffect;
    const pseudo = effect.pseudoElement ?? "";
    if (!pseudo.startsWith("::view-transition-group(")) continue;
    const frames = effect.getKeyframes();
    if (!frames.some((frame) => "width" in frame || "height" in frame)) continue;
    const frame = pseudo.includes(`(${FRAME_NAME}`);
    const stretches = frame || pseudo.includes(`(${STRETCH_NAME}`);
    const endWidth = parseFloat(String(frames.at(-1)?.width));
    const endHeight = parseFloat(String(frames.at(-1)?.height));
    rewrites.push([
      effect,
      frames.map(({ offset, easing, transform, width, height }) => {
        if (!stretches) return { offset, easing, transform };
        // The same functions in every keyframe, so they interpolate one by one rather than as matrices.
        const scale = `scale(${ratio(width, endWidth)}, ${frame ? ratio(height, endHeight) : 1})`;
        return { offset, easing, transform: transform && transform !== "none" ? `${transform} ${scale}` : scale };
      }),
    ]);
  }
  for (const [effect, frames] of rewrites) effect.setKeyframes(frames);
}

/** A keyframe's size over the size it ends at, or 1 where either is missing. */
function ratio(size: unknown, end: number): number {
  const value = parseFloat(String(size));
  return value > 0 && end > 0 ? value / end : 1;
}

/**
 * Holds every snapshot where it starts and starts their clocks together two frames later, as `startSlide` does. The
 * first frame draws all the new snapshots and comes late, and the curve starts fast: on its own clock the transition
 * was a third of the way there by the first frame that showed, which read as a jump. Returns a function that starts
 * them now instead (once).
 */
function holdFirstFrame(animations: Animation[]): () => void {
  for (const animation of animations) animation.pause();
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    const now = document.timeline.currentTime;
    for (const animation of animations) animation.startTime = now;
  };
  requestAnimationFrame(() => requestAnimationFrame(start));
  return start;
}

/** Speeds every animation up so it ends within HURRY_MS, from where it is along its curve. */
function hurryToEnd(animations: Animation[]) {
  for (const animation of animations) {
    const end = Number(animation.effect?.getComputedTiming().endTime ?? 0);
    const left = end - Number(animation.currentTime ?? 0);
    if (left > HURRY_MS) animation.updatePlaybackRate(left / HURRY_MS);
  }
}
