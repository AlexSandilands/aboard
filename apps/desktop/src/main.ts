import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, brandEnv } from "@repo/contracts";
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, shell } from "electron";
import { appIcon } from "./icon.ts";
import { ServerStartError, connectServer, type BoardServer } from "./server.ts";
import { decideNavigation } from "./shell.logic.ts";

const port = Number(process.env[brandEnv("PORT")] ?? 4317);
/** Set by `pnpm desktop`: load the Vite dev server and attach to the API server `pnpm dev` runs. */
const devUrl = process.env[brandEnv("DEV_URL")] ?? null;
/** Passed by the login item so a start at login stays in the tray. */
const HIDDEN_ARG = "--hidden";

// Before anything reads app paths: userData and logs live under the app name, not the package name.
app.setName(BRAND.name);

const here = fileURLToPath(new URL(".", import.meta.url));
const bundle = app.isPackaged
  ? join(process.resourcesPath, "server", "server.mjs")
  : join(here, "../../server/dist/server.mjs");
const webDist = app.isPackaged ? join(process.resourcesPath, "web") : null;

let server: BoardServer | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function boardUrl(): string {
  return devUrl ?? server?.url ?? `http://127.0.0.1:${port}`;
}

function openExternally(url: string): void {
  if (decideNavigation(url, boardUrl()) === "external") void shell.openExternal(url);
}

function createWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: BRAND.name,
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  if (show) win.once("ready-to-show", () => win.show());
  // Closing hides to the tray so the MCP endpoint stays up for agents.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, boardUrl()) === "allow") void win.loadURL(url);
    else openExternally(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (decideNavigation(url, boardUrl()) === "allow") return;
    event.preventDefault();
    openExternally(url);
  });
  void win.loadURL(boardUrl());
  return win;
}

function showWindow(): void {
  window ??= createWindow(false);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function loginItemArgs() {
  return { args: [HIDDEN_ARG] };
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: `Open ${BRAND.name}`, click: showWindow },
    {
      label: "Copy MCP URL",
      enabled: server !== null,
      // The API server's URL even in dev, where the window shows the Vite server instead.
      click: () => server && clipboard.writeText(`${server.url}/mcp`),
    },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      // A dev build would register the bare electron binary.
      enabled: app.isPackaged,
      checked: app.getLoginItemSettings(loginItemArgs()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...loginItemArgs() }),
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function createTray(): Tray {
  const t = new Tray(appIcon());
  t.setToolTip(BRAND.name);
  t.setContextMenu(buildTrayMenu());
  t.on("click", showWindow);
  return t;
}

async function reportStartFailure(error: unknown): Promise<void> {
  const logs = error instanceof ServerStartError ? error.logs : String(error);
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: BRAND.name,
    message: `${BRAND.name} could not start its server`,
    detail: `${error instanceof Error ? error.message : ""}\n\n${logs}`.trim(),
    buttons: ["Quit", "Open log folder"],
    defaultId: 0,
  });
  if (response === 1) await shell.openPath(app.getPath("logs"));
}

async function start(): Promise<void> {
  tray = createTray();
  try {
    server = await connectServer({
      port,
      bundle,
      webDist,
      attachOnly: devUrl !== null,
      onUnexpectedExit(details) {
        dialog.showErrorBox(`${BRAND.name} server stopped`, details);
        app.exit(1);
      },
    });
  } catch (error) {
    await reportStartFailure(error);
    app.exit(1);
    return;
  }
  tray.setContextMenu(buildTrayMenu());
  window = createWindow(!process.argv.includes(HIDDEN_ARG));
}

if (app.requestSingleInstanceLock()) {
  app.setAppUserModelId(`com.${BRAND.id}.desktop`);
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  // Without a listener Electron quits when the last window closes; we live in the tray.
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    quitting = true;
    if (!server?.owned) return;
    const owned = server;
    server = null;
    event.preventDefault();
    void owned.stop().finally(() => app.quit());
  });
  void app.whenReady().then(start);
} else {
  app.quit();
}
