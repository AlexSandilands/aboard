// Sandboxed preload: only `electron`'s renderer modules are available, and it must bundle to CommonJS.
import type { DesktopBridge } from "@repo/contracts";
import { contextBridge, ipcRenderer } from "electron";
import { SET_THEME_CHANNEL } from "./ipc.ts";

const bridge: DesktopBridge = {
  setTheme: (theme) => ipcRenderer.send(SET_THEME_CHANNEL, theme),
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);
