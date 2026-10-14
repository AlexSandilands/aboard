import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

// Frameless window with native controls painted over the page (T3 Code's setup). The web app
// detects the overlay through navigator.windowControlsOverlay and keeps its top bars clear of it.
const TITLEBAR_HEIGHT = 40;
// Fully transparent #00000000 renders incorrectly on Linux.
const TITLEBAR_COLOR = "#01000000";
const SYMBOL_COLOR = { light: "#1f2937", dark: "#f8fafc" };
/** The web app's `--background` per theme, so the window doesn't flash before the page paints. */
const BACKGROUND_COLOR = { light: "#fcfcfc", dark: "#0a0a0a" };

type TitleBarOptions = Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "backgroundColor">;

export function titleBarOptions(dark: boolean): TitleBarOptions {
  const scheme = dark ? "dark" : "light";
  // macOS keeps the native frame until it's a supported target: the sidebar wordmark sits where
  // the traffic lights would go.
  if (process.platform === "darwin") return { backgroundColor: BACKGROUND_COLOR[scheme] };
  return {
    backgroundColor: BACKGROUND_COLOR[scheme],
    titleBarStyle: "hidden",
    titleBarOverlay: { color: TITLEBAR_COLOR, height: TITLEBAR_HEIGHT, symbolColor: SYMBOL_COLOR[scheme] },
  };
}

/** Restyles an existing window after the theme changes. */
export function syncTitleBar(window: BrowserWindow, dark: boolean): void {
  if (window.isDestroyed()) return;
  const { backgroundColor, titleBarOverlay } = titleBarOptions(dark);
  if (backgroundColor) window.setBackgroundColor(backgroundColor);
  if (typeof titleBarOverlay === "object") window.setTitleBarOverlay(titleBarOverlay);
}
