// Sandboxed preload: only `electron`'s renderer modules are available, and it must bundle to CommonJS.
import type { DesktopBridge, DesktopNotification } from "@repo/contracts";
import { contextBridge, ipcRenderer } from "electron";
import { NOTIFICATION_CLICK_CHANNEL, NOTIFY_CHANNEL, SET_BADGE_CHANNEL, SET_THEME_CHANNEL } from "./ipc.ts";

const bridge: DesktopBridge = {
  setTheme: (theme) => ipcRenderer.send(SET_THEME_CHANNEL, theme),
  notify: (notification) => ipcRenderer.send(NOTIFY_CHANNEL, notification),
  setBadge: (badge) => ipcRenderer.send(SET_BADGE_CHANNEL, badge),
  onNotificationClick(listener) {
    const handler = (_event: unknown, notification: DesktopNotification) => listener(notification);
    ipcRenderer.on(NOTIFICATION_CLICK_CHANNEL, handler);
    return () => void ipcRenderer.removeListener(NOTIFICATION_CLICK_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);
