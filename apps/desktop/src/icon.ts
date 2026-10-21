import { fileURLToPath } from "node:url";
import { nativeImage, type NativeImage } from "electron";
import type { TrayIconStyle } from "./desktopPrefs.ts";

/** Rasterised from the web favicon by `scripts/build.ts`; inside the asar when packaged. */
const ICONS_DIR = fileURLToPath(new URL("./icons/", import.meta.url));

/** Window and taskbar icon. */
export function appIcon(): NativeImage {
  return nativeImage.createFromPath(`${ICONS_DIR}icon.png`);
}

/** Tray icon, with a red dot while something is unread; Electron also loads the `@1.5x`/`@2x` files next to it for high-DPI displays. */
export function trayIcon(style: TrayIconStyle, unread = false): NativeImage {
  const prefix = style === "colour" ? "tray" : `tray-${style}`;
  return nativeImage.createFromPath(`${ICONS_DIR}${prefix}${unread ? "-unread" : ""}.png`);
}

export type MenuIconName = "app-window" | "copy" | "palette" | "rotate-cw" | "power";

/** A menu item's icon, drawn for a light or a dark menu; the `@2x` file next to it serves high-DPI displays. */
export function menuIcon(name: MenuIconName, dark: boolean): NativeImage {
  return nativeImage.createFromPath(`${ICONS_DIR}menu/${dark ? "dark" : "light"}/${name}.png`);
}
