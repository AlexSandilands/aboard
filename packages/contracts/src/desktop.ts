/** The web app's theme choice; the desktop shell styles the native window controls to match. */
export type DesktopTheme = "light" | "dark" | "system";

/** API the desktop shell's preload exposes as `window.desktopBridge`. Absent in a plain browser. */
export interface DesktopBridge {
  setTheme(theme: DesktopTheme): void;
}
