import { fileURLToPath } from "node:url";
import { nativeImage, type NativeImage } from "electron";

/** Rasterised from the web favicon by `scripts/build.ts`; inside the asar when packaged. */
const ICONS_DIR = fileURLToPath(new URL("./icons/", import.meta.url));

/** Window and taskbar icon. */
export function appIcon(): NativeImage {
  return nativeImage.createFromPath(`${ICONS_DIR}icon.png`);
}

/** Tray icon, with a red dot while something is unread; Electron also loads the `@1.5x`/`@2x` files next to it for high-DPI displays. */
export function trayIcon(unread = false): NativeImage {
  return nativeImage.createFromPath(`${ICONS_DIR}${unread ? "tray-unread" : "tray"}.png`);
}
