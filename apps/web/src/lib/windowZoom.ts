import {
  homeIsPanel,
  homeOnTaskOpened,
  homeOnWindowOpen,
  type TaskHome,
  cropClipCss,
  cropTransform,
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
/** The docked panel's box when the way in was recorded: the panel may be gone by the time the window mounts. */
let pendingPanelRect: ZoomRect | null = null;

/**
 * Where the open task goes back to when its window is left without docking or closing it explicitly (Esc, the
 * backdrop): the docked panel when it was open as the window opened, otherwise the board, where the window closes onto
 * the card. A window opened with no panel open gets none behind it either (`AppLayout`). Recorded with the window's
 * source (`noteWindowSource`): a double-click counts the panel as it was before its first click.
 */
let home: TaskHome | null = null;

/** The task open now, from the URL: a way in that acts on whichever task is open names none. */
const openTaskId = () => new URLSearchParams(window.location.search).get("task");

/**
 * Called by every way a task is opened, before it navigates: a task opened inside the window (a #N link) stays in it
 * and inherits the window's home.
 */
export function noteTaskOpened(taskId: string) {
  home = homeOnTaskOpened(home, taskId, document.querySelector("[data-task-window]") !== null);
}

/** Docking the window makes the panel the task's home. */
export function noteTaskDocked(taskId: string) {
  home = { taskId, panel: true };
}

/** Whether `taskId`'s window goes back to the docked panel; a task with no record (a restored URL) does. */
export function taskHomeIsPanel(taskId: string): boolean {
  return homeIsPanel(home, taskId);
}

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
  const id = taskId ?? openTaskId();
  if (id) home = homeOnWindowOpen(id, pending.source);
  pendingPanelRect = pending.source === "panel" ? (panelZoomTarget()?.rect ?? null) : null;
}

/**
 * What the window of `taskId` that mounts now grows out of, taken so that a later mount doesn't reuse it: the panel as
 * it was when the way in was recorded (its task may not keep it behind the window), else the card; null fades.
 */
export function takeWindowSource(taskId: string): ZoomTarget | null {
  const source = freshSource(pending, taskId, performance.now());
  const panelRect = pendingPanelRect;
  pending = null;
  pendingPanelRect = null;
  if (source === "panel") {
    if (panelRect) return { rect: panelRect, radius: 0, fade: false };
    // A panel that went meanwhile leaves the card.
    return panelZoomTarget() ?? cardZoomTarget(taskId);
  }
  return source === "card" ? cardZoomTarget(taskId) : null;
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

/** How far the clip reaches past the window at rest, to keep its shadow (`shadow-2xl`) while a crop runs. */
const SHADOW_OUTSET = 64;

function zoomKeyframes(popup: HTMLElement, target: ZoomTarget): { source: Keyframe; rest: Keyframe } | null {
  const rest = restRect(popup);
  // The panel is about the window's height and a third of its width: the window moves and crops onto it instead of
  // scaling, so it lands at the size the panel shows it. The card is small and the window fades over it, so it scales.
  if (!target.fade) {
    const crop = cropTransform(target.rect, rest);
    if (!crop) return null;
    const radius = Number.parseFloat(getComputedStyle(popup).borderTopLeftRadius) || 0;
    return {
      source: {
        transform: `translate(${crop.dx}px, ${crop.dy}px)`,
        clipPath: cropClipCss(crop, target.radius),
        opacity: 1,
        scale: "1",
      },
      rest: {
        transform: "none",
        clipPath: cropClipCss({ right: 0, bottom: 0 }, radius, SHADOW_OUTSET),
        opacity: 1,
        scale: "1",
      },
    };
  }
  const transform = zoomTransform(target.rect, rest);
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
 * waits for the popup's animations before it reports the window closed, so whoever navigates still waits. With the
 * zoom off or nowhere to go it starts nothing, and the window fades out as usual. A zoom in still running (Esc as the
 * window opens) turns around from where it is.
 */
export function zoomOut(popup: HTMLElement, destination: () => ZoomTarget | null) {
  // Whichever way the window goes, it is going: a second close, or a zoom in still waiting for a board transition,
  // starts nothing on it.
  if (leaving.has(popup)) return;
  leaving.add(popup);
  const duration = zoomDuration();
  const running = popup.getAnimations().filter((animation) => animation.id === ZOOM_ID);
  const target = duration > 0 ? destination() : null;
  const frames = target && zoomKeyframes(popup, target);
  if (!target || !frames) {
    // The fade takes over from where the window rests.
    for (const animation of running) animation.finish();
    return;
  }
  if (!target.fade) {
    dockGhost(popup, frames, running, duration);
    return;
  }
  // Read before the running zoom is cancelled: the style is live, and without the zoom it is the window at rest.
  const style = getComputedStyle(popup);
  const opacity = style.opacity;
  const from: Keyframe = { transform: style.transform, borderRadius: style.borderTopLeftRadius, opacity, scale: "1" };
  const progress = running[0]?.effect?.getComputedTiming().progress ?? 1;
  for (const animation of running) animation.cancel();
  popup.animate(target.fade ? [from, { opacity, offset: FADE_OUT_START }, frames.source] : [from, frames.source], {
    duration: turnDurationMs(duration, progress),
    easing: ZOOM_EASING,
    fill: "forwards",
    id: ZOOM_ID,
  });
}

/*
 * Docking: the panel can only show the task once the window has gone (one live panel), so a window landing on it
 * would be swapped for the panel's own layout in one frame, and its contents be seen settling. Instead the window
 * hands over to an inert copy of itself and goes at once, so the task docks under the copy. The copy's contents fade
 * to nothing as it moves onto the panel, an empty surface by the time it lands; the panel keeps its contents hidden
 * meanwhile (`data-task-docking` on <html>, index.css), then they fade in from the top down, all at once.
 */

/** The copy's contents are gone by this share of its move. */
const GHOST_FADE_END = 0.6;
/**
 * The copy's border and shadow are gone by this share of its move: landing on the panel, the window's grey edge would
 * draw a line through it for a moment.
 */
const GHOST_EDGE_END = 0.25;
/** The panel's contents fade in, from the top down, over this share of the zoom's duration. */
const REVEAL_SCALE = 1.2;
/** The copy and the hiding are undone this long after the animations should have ended, whatever happens to them. */
const GHOST_GRACE_MS = 2000;

/**
 * Fades the docked panel's contents in from the top down: a mask three times their height, opaque over its top third
 * and transparent over its bottom third, slid down so the soft middle passes from the top edge to the bottom one. The
 * mask is on the contents' box (its surface too, as the contents are several elements), so the aside behind it takes
 * the surface's colour meanwhile and the board doesn't show through.
 */
function revealPanel(duration: number) {
  const contents = document.querySelector<HTMLElement>("[data-panel-contents]");
  const aside = contents?.closest<HTMLElement>("[data-task-panel]");
  delete document.documentElement.dataset.taskDocking;
  if (!contents || !aside) return;
  aside.style.backgroundColor = getComputedStyle(contents).backgroundColor;
  Object.assign(contents.style, {
    maskImage: "linear-gradient(to bottom, black 33.34%, transparent 66.66%)",
    maskSize: "100% 300%",
    maskRepeat: "no-repeat",
  });
  const clear = () => {
    for (const property of ["mask-image", "mask-size", "mask-repeat"]) contents.style.removeProperty(property);
    aside.style.removeProperty("background-color");
  };
  contents
    .animate([{ maskPosition: "0 100%" }, { maskPosition: "0 0%" }], { duration, easing: "ease-out" })
    .finished.then(clear, clear);
}

function dockGhost(
  popup: HTMLElement,
  frames: { source: Keyframe; rest: Keyframe },
  running: Animation[],
  duration: number,
) {
  const style = getComputedStyle(popup);
  const from: Keyframe = {
    transform: style.transform,
    clipPath: style.clipPath === "none" ? frames.rest.clipPath : style.clipPath,
  };
  const progress = running[0]?.effect?.getComputedTiming().progress ?? 1;
  const rest = restRect(popup);
  const ghost = popup.cloneNode(true) as HTMLElement;
  // A copy for the eye only: no ids twice in the page, nothing to focus or announce, none of the dialog's hooks.
  for (const element of [ghost, ...ghost.querySelectorAll("[id]")]) element.removeAttribute("id");
  // `data-task-window` is on the popup's child: left on the copy, a task opened while it docks would count as opened
  // inside the window.
  for (const element of ghost.querySelectorAll("[data-task-window]")) element.removeAttribute("data-task-window");
  for (const name of ["data-app-modal", "data-starting-style", "data-ending-style", "role"])
    ghost.removeAttribute(name);
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rest.left}px`,
    top: `${rest.top}px`,
    width: `${rest.width}px`,
    height: `${rest.height}px`,
    maxWidth: "none",
    maxHeight: "none",
    margin: "0",
    zIndex: "60",
    pointerEvents: "none",
    transition: "none",
  });
  document.documentElement.dataset.taskDocking = "";
  document.body.append(ghost);
  // The copy starts scrolled to the top; give it the window's scroll positions.
  const viewports = popup.querySelectorAll<HTMLElement>("[data-slot=scroll-area-viewport]");
  ghost.querySelectorAll<HTMLElement>("[data-slot=scroll-area-viewport]").forEach((viewport, i) => {
    viewport.scrollTop = viewports[i]?.scrollTop ?? 0;
  });
  for (const animation of running) animation.cancel();
  // The window itself goes now: hidden at once, so the dialog closes and the task docks under the copy.
  popup.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: "forwards", id: ZOOM_ID });
  const moveMs = turnDurationMs(duration, progress);
  const revealMs = Math.round(duration * REVEAL_SCALE);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timeout);
    ghost.remove();
    revealPanel(revealMs);
  };
  const timeout = window.setTimeout(finish, 3 * (moveMs + revealMs) + GHOST_GRACE_MS);
  for (const child of ghost.children) {
    child.animate([{ opacity: 1 }, { opacity: 0, offset: GHOST_FADE_END }, { opacity: 0 }], {
      duration: moveMs,
      fill: "forwards",
    });
  }
  ghost.animate(
    [
      { borderColor: style.borderTopColor, boxShadow: style.boxShadow },
      { borderColor: "transparent", boxShadow: "none", offset: GHOST_EDGE_END },
      { borderColor: "transparent", boxShadow: "none" },
    ],
    { duration: moveMs, fill: "forwards" },
  );
  ghost
    .animate([from, { transform: frames.source.transform, clipPath: frames.source.clipPath }], {
      duration: moveMs,
      easing: ZOOM_EASING,
      fill: "forwards",
    })
    .finished.then(finish, finish);
}
