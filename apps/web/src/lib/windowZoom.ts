import {
  freshSource,
  type PendingSource,
  radiusCss,
  transformCss,
  turnDurationMs,
  visibleSource,
  ZOOM_EASING,
  type ZoomRect,
  type ZoomSource,
  zoomDurationMs,
  zoomTransform,
} from "./windowZoom.logic";

/*
 * The task window's zoom (Appearance → Motion → Zoom windows from their source): the window grows out of the docked
 * panel when that is open, otherwise out of the task's card, and shrinks back when it docks or closes. A FLIP on the
 * window's popup: it is laid out at rest and animated from (or to) a transform that puts it on its source, which the
 * compositor runs. Without a source the window keeps its fade (`AppRouteModal`).
 */

const ZOOM_ID = "window-zoom";

/** Where a zoom starts or ends: a box on screen, its corner radius, and whether the window fades as it gets there. */
export interface ZoomTarget {
  rect: ZoomRect;
  radius: number;
  /**
   * The card is far smaller than the window, so the window fades in as it leaves it and out as it lands. Over the
   * panel it stays solid: it covers the panel's placeholder until the panel has the task again.
   */
  fade: boolean;
}

/** What a window gives `AppRouteModal` to zoom: each is asked as its animation starts, and null gives the fade. */
export interface WindowZoom {
  enter: () => ZoomTarget | null;
  exit: () => ZoomTarget | null;
}

/** The zoom's length in ms; 0 when the setting is off, Panel animations is at 0 or motion is reduced. */
function zoomDuration(): number {
  const root = document.documentElement;
  if (root.dataset.panelAnimations !== "true" || root.dataset.windowZoom === "false") return 0;
  return zoomDurationMs(Number.parseFloat(root.style.getPropertyValue("--panel-animation-duration")) || 0);
}

let pending: PendingSource | null = null;

/** The docked panel, when it is open (not sliding out). */
function dockedPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-task-panel]:not([inert])");
}

/** Whether the docked panel is open now: what a window opened now grows out of. */
export function taskPanelOpen(): boolean {
  return dockedPanel() !== null;
}

/**
 * Called by every way into the task window, just before it navigates: records what the window grows out of. Left out,
 * `source` is the docked panel when it is open and the task's card otherwise. A double-click passes its own, since its
 * first click has opened the panel by the time the second expands it.
 */
export function noteWindowSource(taskId: string | null, source?: ZoomSource) {
  pending = { taskId, source: source ?? (taskPanelOpen() ? "panel" : "card"), at: performance.now() };
}

/** The source recorded for the window of `taskId` that mounts now, taken so that a later mount doesn't reuse it. */
export function takeWindowSource(taskId: string): ZoomSource | null {
  const source = freshSource(pending, taskId, performance.now());
  pending = null;
  return source;
}

/** The docked panel as a zoom target, or null when it isn't open. */
export function panelZoomTarget(): ZoomTarget | null {
  const panel = dockedPanel();
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { rect, radius: 0, fade: false } : null;
}

/**
 * The task's card as a zoom target, or null when it isn't on screen: scrolled out of the board, in a collapsed lane or
 * column, or filtered out. A task can have more than one card (the priority lane repeats it): the first one showing.
 */
export function cardZoomTarget(taskId: string): ZoomTarget | null {
  const scroller = document.querySelector("[data-board-scroll]");
  if (!scroller) return null;
  const viewport = scroller.getBoundingClientRect();
  for (const card of scroller.querySelectorAll<HTMLElement>(`[data-task-card="${CSS.escape(taskId)}"]`)) {
    const rect = visibleSource(card.getBoundingClientRect(), viewport);
    if (rect) return { rect, radius: Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0, fade: true };
  }
  return null;
}

/** Popups that have had their way in, so a re-attached ref (StrictMode, a re-render) doesn't play it again. */
const entered = new WeakSet<HTMLElement>();
const leaving = new WeakSet<HTMLElement>();

/** The popup's box at rest, whatever transform it has now. Its offset parent is the dialog's fixed viewport. */
function restRect(popup: HTMLElement): ZoomRect {
  return { left: popup.offsetLeft, top: popup.offsetTop, width: popup.offsetWidth, height: popup.offsetHeight };
}

function zoomKeyframes(popup: HTMLElement, target: ZoomTarget): { source: Keyframe; rest: Keyframe } | null {
  const transform = zoomTransform(target.rect, restRect(popup));
  if (!transform) return null;
  return {
    // `scale` and `opacity` are named at both ends so the fade's own transition (data-starting-style and
    // data-ending-style in AppRouteModal) doesn't show through: a script animation wins over a transition.
    source: {
      transform: transformCss(transform),
      borderRadius: radiusCss(target.radius, transform),
      opacity: target.fade ? 0 : 1,
      scale: "1",
    },
    rest: { transform: "none", borderRadius: getComputedStyle(popup).borderTopLeftRadius, opacity: 1, scale: "1" },
  };
}

/*
 * How far into the zoom the window is solid when it fades in from a card, and from where it fades out going back, as
 * shares of the distance (the curve has run before these apply): the curve covers the first quarter in about a
 * twentieth of the time, so the window is seen leaving the card, and going back it lands on the card solid and fades
 * over the curve's long tail, which shows the card under it.
 */
const FADE_IN_END = 0.25;
const FADE_OUT_START = 0.85;

/**
 * Grows the window's popup out of what `source` returns. Does nothing (the window fades in as usual) when the zoom is
 * off or there is no source. While the board is in a View Transition (the panel opening under a double-click) the page
 * shows snapshots and the window not at all, so the zoom waits for it and measures the source where it ended up.
 */
export function zoomIn(popup: HTMLElement, source: () => ZoomTarget | null) {
  if (entered.has(popup)) return;
  entered.add(popup);
  const duration = zoomDuration();
  if (duration === 0) return;
  const start = () => {
    if (!popup.isConnected || leaving.has(popup)) return;
    const target = source();
    const frames = target && zoomKeyframes(popup, target);
    if (!frames) return;
    popup.animate([frames.source, { opacity: 1, offset: FADE_IN_END }, frames.rest], {
      duration,
      easing: ZOOM_EASING,
      id: ZOOM_ID,
    });
  };
  const transition = document.activeViewTransition;
  if (transition) void transition.finished.then(start, start);
  else start();
}

/**
 * Shrinks the window's popup into what `destination` returns and holds it there until the dialog unmounts it; Base UI
 * waits for the popup's animations before it reports the window closed, so whoever navigates still waits. False, doing
 * nothing, when the zoom is off or there is nowhere to go: the window then fades out as usual. A zoom in still running
 * (Esc as the window opens) turns around from where it is.
 */
export function zoomOut(popup: HTMLElement, destination: () => ZoomTarget | null): boolean {
  if (leaving.has(popup)) return true;
  const duration = zoomDuration();
  const running = popup.getAnimations().filter((animation) => animation.id === ZOOM_ID);
  const target = duration > 0 ? destination() : null;
  const frames = target && zoomKeyframes(popup, target);
  if (!target || !frames) {
    // The fade takes over from where the window rests.
    for (const animation of running) animation.finish();
    return false;
  }
  leaving.add(popup);
  const style = getComputedStyle(popup);
  const from: Keyframe = {
    transform: style.transform,
    borderRadius: style.borderTopLeftRadius,
    opacity: style.opacity,
    scale: "1",
  };
  const progress = running[0]?.effect?.getComputedTiming().progress ?? 1;
  for (const animation of running) animation.cancel();
  popup.animate(
    target.fade ? [from, { opacity: style.opacity, offset: FADE_OUT_START }, frames.source] : [from, frames.source],
    { duration: turnDurationMs(duration, progress), easing: ZOOM_EASING, fill: "forwards", id: ZOOM_ID },
  );
  return true;
}
