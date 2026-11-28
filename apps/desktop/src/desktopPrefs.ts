import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Colour is the app's own icon; white and black are single-colour glyphs for a panel that wants one. */
export const TRAY_ICON_STYLES = ["colour", "white", "black"] as const;
export type TrayIconStyle = (typeof TRAY_ICON_STYLES)[number];

/** What the shell itself remembers: preferences about the shell, not the board, so they aren't in the web settings. */
export interface DesktopPrefs {
  trayIcon: TrayIconStyle;
  /** Check for updates by itself, hourly. Check now works either way. */
  autoCheckUpdates: boolean;
  /** The newest version an OS notification has announced, so each version is announced once, across restarts. */
  notifiedUpdate: string | null;
  /** The version whose release notes the user has seen (or that was installed fresh); null until the first launch. */
  lastSeenVersion: string | null;
  /** Open the release notes on the first launch after an update. */
  showReleaseNotes: boolean;
}

const DEFAULTS: DesktopPrefs = {
  trayIcon: "colour",
  autoCheckUpdates: true,
  notifiedUpdate: null,
  lastSeenVersion: null,
  showReleaseNotes: true,
};

const version = (value: unknown): string | null => (typeof value === "string" && value.length <= 50 ? value : null);
const FILE = "prefs.json";

/** Keeps what is valid and defaults the rest, so a hand-edited or older file never stops the shell starting. */
export function parsePrefs(value: unknown): DesktopPrefs {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const trayIcon = TRAY_ICON_STYLES.find((style) => style === raw.trayIcon);
  return {
    trayIcon: trayIcon ?? DEFAULTS.trayIcon,
    autoCheckUpdates: typeof raw.autoCheckUpdates === "boolean" ? raw.autoCheckUpdates : DEFAULTS.autoCheckUpdates,
    notifiedUpdate: version(raw.notifiedUpdate),
    lastSeenVersion: version(raw.lastSeenVersion),
    showReleaseNotes: typeof raw.showReleaseNotes === "boolean" ? raw.showReleaseNotes : DEFAULTS.showReleaseNotes,
  };
}

/** Reads `<dir>/prefs.json`; a missing or corrupt file gives the defaults. */
export function readPrefs(dir: string): DesktopPrefs {
  try {
    return parsePrefs(JSON.parse(readFileSync(join(dir, FILE), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Writes through a temporary file so a crash mid-write can't leave a half-written one. */
export function writePrefs(dir: string, prefs: DesktopPrefs): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`);
  renameSync(temp, file);
}
