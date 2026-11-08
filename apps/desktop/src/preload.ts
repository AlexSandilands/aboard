// Sandboxed preload: only `electron`'s renderer modules are available, and it must bundle to CommonJS.
import type { DesktopBridge, DesktopNotification, DesktopUpdateState } from "@repo/contracts";
import { contextBridge, ipcRenderer } from "electron";
import {
  CHECK_FOR_UPDATES_CHANNEL,
  GET_UPDATE_STATE_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  NOTIFICATION_CLICK_CHANNEL,
  NOTIFY_CHANNEL,
  SET_BACKGROUND_CHANNEL,
  SET_BADGE_CHANNEL,
  OPEN_RELEASE_NOTES_CHANNEL,
  SET_AUTO_CHECK_UPDATES_CHANNEL,
  SET_THEME_CHANNEL,
  UPDATE_STATE_CHANNEL,
} from "./ipc.ts";

const bridge: DesktopBridge = {
  setTheme: (theme) => ipcRenderer.send(SET_THEME_CHANNEL, theme),
  setBackgroundColor: (color) => ipcRenderer.send(SET_BACKGROUND_CHANNEL, color),
  notify: (notification) => ipcRenderer.send(NOTIFY_CHANNEL, notification),
  setBadge: (badge) => ipcRenderer.send(SET_BADGE_CHANNEL, badge),
  onNotificationClick(listener) {
    const handler = (_event: unknown, notification: DesktopNotification) => listener(notification);
    ipcRenderer.on(NOTIFICATION_CLICK_CHANNEL, handler);
    return () => void ipcRenderer.removeListener(NOTIFICATION_CLICK_CHANNEL, handler);
  },
  getUpdateState: () => ipcRenderer.invoke(GET_UPDATE_STATE_CHANNEL) as Promise<DesktopUpdateState>,
  onUpdateState(listener) {
    const handler = (_event: unknown, state: DesktopUpdateState) => listener(state);
    ipcRenderer.on(UPDATE_STATE_CHANNEL, handler);
    return () => void ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, handler);
  },
  checkForUpdates: () => ipcRenderer.send(CHECK_FOR_UPDATES_CHANNEL),
  installUpdate: () => ipcRenderer.send(INSTALL_UPDATE_CHANNEL),
  setAutoCheckUpdates: (enabled) => ipcRenderer.send(SET_AUTO_CHECK_UPDATES_CHANNEL, enabled),
  openReleaseNotes: () => ipcRenderer.send(OPEN_RELEASE_NOTES_CHANNEL),
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);
