import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Colour is the app's own icon; white and black are single-colour glyphs for a panel that wants one. */
export const TRAY_ICON_STYLES = ["colour", "white", "black"] as const;
export type TrayIconStyle = (typeof TRAY_ICON_STYLES)[number];

/** What the shell itself remembers: preferences about the shell, not the board, so they aren't in the web settings. */
export interface DesktopPrefs {
  trayIcon: TrayIconStyle;
}

const DEFAULTS: DesktopPrefs = { trayIcon: "colour" };
const FILE = "prefs.json";

/** Keeps what is valid and defaults the rest, so a hand-edited or older file never stops the shell starting. */
export function parsePrefs(value: unknown): DesktopPrefs {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const trayIcon = TRAY_ICON_STYLES.find((style) => style === raw.trayIcon);
  return { trayIcon: trayIcon ?? DEFAULTS.trayIcon };
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
