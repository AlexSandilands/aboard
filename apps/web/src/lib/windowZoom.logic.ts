/*
 * The pure part of the task window's zoom (the DOM part is `windowZoom.ts`): the window grows out of the task's card or
 * the docked panel and shrinks back into it, as a FLIP. The window is laid out at its resting place and starts
 * transformed onto its source.
 */

/** The zoom runs this many times the Panel animations setting: 150 ms gives 300 ms. */
const ZOOM_SCALE = 2;

/**
 * The zoom's curve, both ways: the slide's (`SLIDE_EASING`), a fast start and a long soft tail, so the window is most
 * of the way there early and settles, and the panel's slide and the zoom read as one motion.
 */
export const ZOOM_EASING = "cubic-bezier(0.2, 0.9, 0.25, 1)";

/** A zoom started over one still running (Esc as the window opens) shows for at least this share of the duration. */
const MIN_TURN_SHARE = 0.4;

/** How long the zoom takes for a Panel animations setting of `panelAnimationMs`; 0 is off. */
export function zoomDurationMs(panelAnimationMs: number): number {
  return panelAnimationMs > 0 ? Math.round(panelAnimationMs * ZOOM_SCALE) : 0;
}

export interface ZoomRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the window comes from and goes back to: the docked panel, or the task's card on the board. */
export type ZoomSource = "panel" | "card";

/** How long ago a way in may have recorded its source for the window that mounts now to still take it. */
const SOURCE_FRESH_MS = 2000;

export interface PendingSource {
  /** Null is whichever task is open (the expand button and its shortcut act on it). */
  taskId: string | null;
  source: ZoomSource;
  at: number;
}

/**
 * The source a way in recorded for the window of `taskId` mounting at `now`, or null: a window that is restored rather
 * than opened (on load, or coming back from behind Settings) has none, and fades in.
 */
export function freshSource(pending: PendingSource | null, taskId: string, now: number): ZoomSource | null {
  if (!pending || now - pending.at > SOURCE_FRESH_MS) return null;
  return pending.taskId === null || pending.taskId === taskId ? pending.source : null;
}

/**
 * The part of `rect` inside `viewport`, or null when too little of it shows to zoom to: a card scrolled out of the
 * board, or one whose lane or column is collapsed (no box at all). Half of each side has to show, or the window would
 * land on a sliver at the board's edge.
 */
export function visibleSource(rect: ZoomRect, viewport: ZoomRect): ZoomRect | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left = Math.max(rect.left, viewport.left);
  const top = Math.max(rect.top, viewport.top);
  const right = Math.min(rect.left + rect.width, viewport.left + viewport.width);
  const bottom = Math.min(rect.top + rect.height, viewport.top + viewport.height);
  if (right - left < rect.width / 2 || bottom - top < rect.height / 2) return null;
  return rect;
}

export interface ZoomTransform {
  /** How far the source's centre is from the window's, in px. */
  dx: number;
  dy: number;
  /** The source's size over the window's. */
  sx: number;
  sy: number;
}

/** The transform (about the window's centre) that puts the window at rest, `target`, onto `source`. */
export function zoomTransform(source: ZoomRect, target: ZoomRect): ZoomTransform | null {
  if (target.width <= 0 || target.height <= 0 || source.width <= 0 || source.height <= 0) return null;
  return {
    dx: source.left + source.width / 2 - (target.left + target.width / 2),
    dy: source.top + source.height / 2 - (target.top + target.height / 2),
    sx: source.width / target.width,
    sy: source.height / target.height,
  };
}

export function transformCss(transform: ZoomTransform): string {
  return `translate(${round(transform.dx)}px, ${round(transform.dy)}px) scale(${round(transform.sx, 5)}, ${round(transform.sy, 5)})`;
}

/**
 * Docking and undocking: the window moves onto the panel and is cropped to its box, at its real size. Scaled instead,
 * it lands squashed to the panel's narrow, tall shape, a frame of stretched text before the panel takes over.
 */
export interface CropTransform {
  /** How far the window's top-left corner moves to sit on the source's, in px. */
  dx: number;
  dy: number;
  /** How much of the window's right and bottom is cut off, so what shows is the source's size. */
  right: number;
  bottom: number;
}

/** The move and crop that put the window at rest, `target`, onto `source` at its own size; null with no box. */
export function cropTransform(source: ZoomRect, target: ZoomRect): CropTransform | null {
  if (target.width <= 0 || target.height <= 0 || source.width <= 0 || source.height <= 0) return null;
  return {
    dx: source.left - target.left,
    dy: source.top - target.top,
    // A source larger than the window on a side (the panel is often taller) crops nothing there.
    right: Math.max(0, target.width - source.width),
    bottom: Math.max(0, target.height - source.height),
  };
}

/**
 * The crop's clip path. `outset` grows the clip past the window's box on every side, so at rest it doesn't cut off
 * the window's shadow (a clip can only animate to another inset(), not to none).
 */
export function cropClipCss(crop: Pick<CropTransform, "right" | "bottom">, radius: number, outset = 0): string {
  const edge = (value: number) => `${round(value - outset)}px`;
  return `inset(${edge(0)} ${edge(crop.right)} ${edge(crop.bottom)} ${edge(0)} round ${round(radius)}px)`;
}

/**
 * The window's border radius while it sits on its source, so its corners look like the source's (`radius` px): the
 * transform scales the corners with everything else, so the radius is divided by the scale on each axis.
 */
export function radiusCss(radius: number, transform: ZoomTransform): string {
  return `${round(radius / transform.sx)}px / ${round(radius / transform.sy)}px`;
}

/**
 * How long a zoom runs when it takes over from one `progress` (0 to 1) of the way through: the part already covered,
 * since that is the distance back, but never so short that it reads as a jump.
 */
export function turnDurationMs(durationMs: number, progress: number): number {
  const share = Math.min(1, Math.max(MIN_TURN_SHARE, progress));
  return Math.round(durationMs * share);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Where a task in the window goes back to when it is left without docking or closing it explicitly (Esc, the
 * backdrop): the docked panel (`panel`), or the board, where the window closes onto the card. Null is no record.
 */
export interface TaskHome {
  taskId: string;
  panel: boolean;
}

/** The home recorded as the window of `taskId` opens: the panel when the window grows out of it. */
export function homeOnWindowOpen(taskId: string, source: ZoomSource): TaskHome {
  return { taskId, panel: source === "panel" };
}

/** The home after `taskId` is opened: one opened inside the window (a #N link) inherits the window's. */
export function homeOnTaskOpened(home: TaskHome | null, taskId: string, inWindow: boolean): TaskHome | null {
  return home && inWindow ? { taskId, panel: home.panel } : home;
}

/** Whether `taskId`'s window goes back to the docked panel; a task with no record (a restored URL) does. */
export function homeIsPanel(home: TaskHome | null, taskId: string): boolean {
  return home?.taskId === taskId ? home.panel : true;
}

/**
 * Whether leaving the window closes the task rather than docking it: `leaving` is what an explicit way out said
 * (the × closes, the dock button and `f` dock), null (Esc, the backdrop) goes home.
 */
export function leaveCloses(leaving: "close" | "dock" | null, homePanel: boolean): boolean {
  return leaving ? leaving === "close" : !homePanel;
}
