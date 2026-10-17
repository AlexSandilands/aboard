import type { CSSProperties } from "react";
import { hashHue } from "~/components/labels/labels.logic";

// An epic reads as a frame around cards, not as a card: a heavier neutral border (cards have 1px at 60%), a larger
// radius, and a faint fill on its header like a folder tab. Not coloured, since a blue border would be mistaken for the
// selection state.
export const EPIC_FRAME_CLASS = "rounded-2xl border-2 border-foreground/14 bg-muted/25";
export const EPIC_HEADER_CLASS = "rounded-t-xl bg-foreground/5";

/**
 * Whether epics get a thin accent bar on their left edge, in a colour taken from their name. Off until the user has
 * judged it against the plain frame.
 */
export const EPIC_ACCENT_BAR = false;

/** The hues the accent bar avoids: cyan to indigo, which the selection blue (about 264°) would blend into. */
const AVOIDED_FROM = 195;
const AVOIDED_TO = 285;

/** A stable hue for an epic from its title, outside the avoided arc (the label hash, squeezed into what is left). */
export function epicAccentHue(title: string): number {
  return (AVOIDED_TO + (hashHue(title) % (360 - (AVOIDED_TO - AVOIDED_FROM)))) % 360;
}

/** The `--epic-accent` colour for the bar, at the lightness and chroma label chips use. */
export function epicAccentStyle(title: string): CSSProperties {
  return { "--epic-accent": `oklch(0.62 0.16 ${epicAccentHue(title)})` } as CSSProperties;
}

export const EPIC_ACCENT_CLASS =
  "relative before:pointer-events-none before:absolute before:inset-y-2 before:start-0 before:w-[3px] before:rounded-e-full before:bg-(--epic-accent)";
