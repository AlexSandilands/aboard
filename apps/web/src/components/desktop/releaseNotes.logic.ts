// What the desktop app's release notes dialog shows: which releases are new, which is selected, and its words.
import type { DesktopBridge, DesktopRelease } from "@repo/contracts";

export type ReleaseNotesMode = "update" | "history";

function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `a` is a later release than `b`; false when either isn't `x.y.z`. */
export function isLaterVersion(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i]! > y[i]!;
  }
  return false;
}

export interface ReleaseGroups {
  /** After an update: the releases since the version last seen, newest first. Empty from Settings. */
  fresh: DesktopRelease[];
  /** Every other release, newest first. From Settings, all of them. */
  earlier: DesktopRelease[];
}

/** Splits the list (newest first) into what's new since `since` and what came before. */
export function groupReleases(releases: readonly DesktopRelease[], since: string | null): ReleaseGroups {
  if (since === null) return { fresh: [], earlier: [...releases] };
  const fresh = releases.filter((release) => isLaterVersion(release.version, since));
  return { fresh, earlier: releases.filter((release) => !fresh.includes(release)) };
}

/**
 * The release the dialog opens on: the newest new one after an update, otherwise the running version's (or the
 * newest, in a build from source that matches none).
 */
export function defaultRelease(groups: ReleaseGroups, currentVersion: string): DesktopRelease | null {
  return (
    groups.fresh[0] ?? groups.earlier.find((release) => release.version === currentVersion) ?? groups.earlier[0] ?? null
  );
}

/** The dialog's title and the line under it. */
export function releaseNotesHeading(
  mode: ReleaseNotesMode,
  currentVersion: string,
  since: string | null,
  freshCount: number,
): { title: string; description: string } {
  if (mode === "history" || since === null) {
    return { title: "Release notes", description: `You're on v${currentVersion}.` };
  }
  const count = freshCount === 1 ? "1 new release" : `${freshCount} new releases`;
  return {
    title: `What's new in v${currentVersion}`,
    description: freshCount > 0 ? `Updated from v${since} · ${count}` : `Updated from v${since}`,
  };
}

/** How many entries the generated Details list has (its `*` or `-` items), for its summary line. */
export function detailsCount(details: string): number {
  return details.split("\n").filter((line) => /^[*-]\s+\S/.test(line)).length;
}

/** "Details · 3 changes", or just "Details" for one written by hand without a list. */
export function detailsSummary(details: string): string {
  const count = detailsCount(details);
  if (count === 0) return "Details";
  return `Details · ${count} ${count === 1 ? "change" : "changes"}`;
}

/** "28 Nov 2026", in UTC so the day doesn't move with the time zone; empty without a date. */
export function releaseDate(publishedAt: string | null): string {
  if (!publishedAt) return "";
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export type ReleaseNotesBridge = Required<
  Pick<DesktopBridge, "getWhatsNew" | "listReleases" | "dismissWhatsNew" | "setShowReleaseNotes">
>;

/** The shell's release notes methods, or null in a browser or a shell from before them. */
export function releaseNotesBridge(bridge: DesktopBridge | null): ReleaseNotesBridge | null {
  if (!bridge?.getWhatsNew || !bridge.listReleases || !bridge.dismissWhatsNew || !bridge.setShowReleaseNotes) {
    return null;
  }
  return bridge as ReleaseNotesBridge;
}

/**
 * What closing the dialog tells the shell. From Settings, nothing: the checkbox there applies at once. After an
 * update, `dismiss` marks this version seen, except when the notes couldn't be loaded, so they open again on the
 * next launch; "Don't show after updates" is passed on either way.
 */
export function closeAction(
  mode: ReleaseNotesMode,
  loadFailed: boolean,
  stopShowing: boolean,
): { dismiss: boolean; stopShowing: boolean } | null {
  if (mode === "history") return null;
  if (loadFailed && !stopShowing) return null;
  return { dismiss: true, stopShowing };
}

/** The colour a Highlights group's heading gets: the board's success, info and warning tones. */
export type HighlightTone = "success" | "info" | "warning";

export interface HighlightSection {
  /** The `###` heading's text, or null for anything written before the first one. */
  heading: string | null;
  /** Null for a heading the format doesn't name, which stays neutral. */
  tone: HighlightTone | null;
  body: string;
}

const TONES: Record<string, HighlightTone> = {
  new: "success",
  added: "success",
  features: "success",
  improved: "info",
  changed: "info",
  fixed: "warning",
  fixes: "warning",
};

/**
 * Splits Highlights at their `###` headings, so the dialog can draw New, Improved and Fixed as tinted pills
 * (docs/features/releases.md#release-notes). Text before the first heading is a section with no heading; a `###`
 * inside a code fence doesn't split.
 */
export function highlightSections(highlights: string): HighlightSection[] {
  const sections: HighlightSection[] = [];
  let current: HighlightSection = { heading: null, tone: null, body: "" };
  const lines: string[] = [];
  let fenced = false;
  const flush = () => {
    current.body = lines.join("\n").trim();
    if (current.heading !== null || current.body) sections.push(current);
    lines.length = 0;
  };
  for (const line of highlights.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^###\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      flush();
      const heading = match[1]!;
      current = { heading, tone: TONES[heading.toLowerCase()] ?? null, body: "" };
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}
