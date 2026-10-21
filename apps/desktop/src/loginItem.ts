import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAND } from "@repo/contracts";
import { app } from "electron";
import { linuxAutostartEntry } from "./shell.logic.ts";

/** Whether the app starts at login, and switching it. */
export interface LoginItem {
  get(): boolean;
  set(enabled: boolean): void;
}

/**
 * Electron's login items cover Windows and macOS. Linux desktops start what's in the XDG autostart folder instead, so
 * there the item is a desktop entry of ours in it.
 */
export function loginItem(args: string[]): LoginItem {
  if (process.platform !== "linux") {
    return {
      get: () => app.getLoginItemSettings({ args }).openAtLogin,
      set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin, args }),
    };
  }
  const file = join(app.getPath("appData"), "autostart", `${BRAND.id}.desktop`);
  return {
    get: () => existsSync(file),
    set(enabled) {
      if (!enabled) return rmSync(file, { force: true });
      mkdirSync(dirname(file), { recursive: true });
      // An AppImage runs from a mount that goes away when it quits; APPIMAGE is the file itself.
      writeFileSync(file, linuxAutostartEntry(BRAND.name, process.env.APPIMAGE || process.execPath, args));
    },
  };
}
