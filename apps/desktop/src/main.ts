import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, brandEnv, readDesktopSandbox, type DesktopBadge } from "@repo/contracts";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from "electron";
import { TRAY_ICON_STYLES, readPrefs, writePrefs, type TrayIconStyle } from "./desktopPrefs.ts";
import { appIcon, menuIcon, trayIcon } from "./icon.ts";
import {
  NOTIFICATION_CLICK_CHANNEL,
  NOTIFY_CHANNEL,
  SET_BACKGROUND_CHANNEL,
  SET_BADGE_CHANNEL,
  SET_THEME_CHANNEL,
} from "./ipc.ts";
import { loginItem } from "./loginItem.ts";
import { ServerStartError, connectServer, type BoardServer, type ServerOptions } from "./server.ts";
import {
  allowSubFrameNavigation,
  decideNavigation,
  isDesktopTheme,
  parseBackgroundColor,
  parseDesktopBadge,
  parseDesktopNotification,
} from "./shell.logic.ts";
import { syncTitleBar, titleBarOptions } from "./titleBar.ts";

const port = parsePort(process.env[brandEnv("PORT")]);
/** Set by `pnpm desktop`: load the Vite dev server and attach to the API server `pnpm dev` runs. */
const devUrl = app.isPackaged ? null : (process.env[brandEnv("DEV_URL")] ?? null);
/** Bearer token the server enforces when set; the board picks it up from the URL hash. */
const token = process.env[brandEnv("TOKEN")] || null;
/** Passed by the login item so a start at login stays in the tray. */
const HIDDEN_ARG = "--hidden";

// `pnpm sandbox --desktop` opens the shell on the sandbox. It must never point at the real board, so a setup
// that would is refused before anything else runs.
const sandbox = app.isPackaged ? null : readDesktopSandbox(process.env, join(homedir(), `.${BRAND.id}`));
if (sandbox && "error" in sandbox) {
  console.error(`[${BRAND.id}] refusing to open the desktop sandbox: ${sandbox.error}`);
  process.exit(1);
}
/** What the window, tray and notifications call the app; a sandbox shell says so. */
const productName = sandbox ? `${BRAND.name} Sandbox` : BRAND.name;

// Before anything reads app paths: userData, logs and the single-instance lock live under the app name.
// Dev builds get their own, so `pnpm desktop` doesn't hand off to an installed copy that's running.
app.setName(app.isPackaged ? BRAND.name : sandbox ? productName : `${BRAND.name} Dev`);
// The sandbox shell's profile and lock live in the sandbox's throwaway home, so it runs beside the real app
// (and other worktrees' sandboxes) and `pnpm sandbox stop` removes what it wrote.
if (sandbox) app.setPath("userData", join(sandbox.home, "desktop"));

const here = fileURLToPath(new URL(".", import.meta.url));
const bundle = app.isPackaged
  ? join(process.resourcesPath, "server", "server.mjs")
  : join(here, "../../server/dist/server.mjs");
const webDist = app.isPackaged ? join(process.resourcesPath, "web") : null;

let server: BoardServer | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
/** Whether this shell runs the server itself (not attached to `pnpm dev`'s), so it may restart it. */
let ownsServer = false;
/** The server restart in progress, if any; `server` is null meanwhile. */
let restart: Promise<void> | null = null;
/** What the shell remembers about itself, read once the profile path is final. */
let prefs = readPrefs(app.getPath("userData"));
/** The unread count the page last reported, kept to restyle a window created later. */
let badge: DesktopBadge = { count: 0, description: "", overlay: null };
/** Shown notifications, held until they close: Electron drops the click handler of one that is garbage collected. */
const shown = new Set<Notification>();
const MAX_SHOWN = 50;
/** Tray clicks and second launches before the server is ready; the window opens once it is. */
let showRequested = false;
/** The board's theme background, reported by the page; null until it does (the default theme's is used). */
let pageBackground: string | null = null;

function parsePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 4317;
}

function boardUrl(): string {
  return devUrl ?? server?.url ?? `http://127.0.0.1:${port}`;
}

function withToken(url: string, form: "hash" | "query"): string {
  if (!token) return url;
  const value = encodeURIComponent(token);
  return form === "hash" ? `${url}/#token=${value}` : `${url}?token=${value}`;
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
    title: productName,
    icon: appIcon(),
    autoHideMenuBar: true,
    ...titleBarOptions(nativeTheme.shouldUseDarkColors, pageBackground),
    // The preload (and its desktopBridge) runs in the top frame only; sub-frames are agents' sandboxed art.
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegrationInSubFrames: false,
      preload: join(here, "preload.cjs"),
    },
  });
  if (show) win.once("ready-to-show", () => win.show());
  // Restyling the overlay before the window's first show leaves the page's
  // navigator.windowControlsOverlay stuck at visible=false (Electron 44), so the board would lay out
  // as if there were no title bar. The page reports its theme while loading, so apply it on show.
  win.on("show", () => syncTitleBar(win, nativeTheme.shouldUseDarkColors, pageBackground));
  // The page sets the title; keep "Sandbox" on it so the taskbar and Alt+Tab tell the two shells apart.
  if (sandbox) {
    win.on("page-title-updated", (event, title) => {
      event.preventDefault();
      win.setTitle(`${title} - Sandbox`);
    });
  }
  win.once("ready-to-show", () => applyWindowBadge(win));
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
  // The board never uses WebRTC, which CSP doesn't cover; this keeps a piece of art that gets hold of it off UDP.
  win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  // will-navigate only sees the top frame. A sub-frame stays on its srcdoc, and is never handed to the OS either.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !allowSubFrameNavigation(event.url)) event.preventDefault();
  });
  void win.loadURL(withToken(boardUrl(), "hash"));
  return win;
}

/** Windows has no numeric badge, only an overlay image the page drew; macOS and Linux take the count itself. */
function applyWindowBadge(win: BrowserWindow): void {
  if (win.isDestroyed() || process.platform !== "win32") return;
  const overlay = badge.count > 0 && badge.overlay ? nativeImage.createFromDataURL(badge.overlay) : null;
  win.setOverlayIcon(overlay, overlay ? badge.description : "");
}

function applyBadge(next: DesktopBadge): void {
  badge = next;
  if (window) applyWindowBadge(window);
  if (process.platform !== "win32") app.setBadgeCount(next.count);
  tray?.setImage(trayIcon(prefs.trayIcon, next.count > 0));
  tray?.setToolTip(next.count > 0 ? `${productName}: ${next.description}` : productName);
}

function showWindow(): void {
  // Before the first start there is nothing to show yet; during a restart the window exists and shows the board.
  if (!server && !window) {
    showRequested = true;
    return;
  }
  window ??= createWindow(false);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Starts hidden, so a start at login stays in the tray. */
const startAtLogin = loginItem([HIDDEN_ARG]);

const TRAY_ICON_LABELS: Record<TrayIconStyle, string> = { colour: "Colour", white: "White", black: "Black" };

/** Whether the tray menu is dark; Windows has a separate setting for its shell, the board's theme choice must not sway it. */
function menuIsDark(): boolean {
  return process.platform === "win32"
    ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
    : nativeTheme.shouldUseDarkColors;
}

function buildTrayMenu(): Menu {
  const dark = menuIsDark();
  return Menu.buildFromTemplate([
    { label: `Open ${productName}`, icon: menuIcon("app-window", dark), click: showWindow },
    {
      label: "Copy MCP URL",
      icon: menuIcon("copy", dark),
      enabled: server !== null,
      // The API server's URL even in dev, where the window shows the Vite server instead.
      click: () => server && clipboard.writeText(withToken(`${server.url}/mcp`, "query")),
    },
    { type: "separator" },
    {
      label: "Tray icon",
      icon: menuIcon("palette", dark),
      submenu: TRAY_ICON_STYLES.map((style) => ({
        label: TRAY_ICON_LABELS[style],
        type: "radio" as const,
        checked: prefs.trayIcon === style,
        click: () => setTrayIconStyle(style),
      })),
    },
    {
      label: "Start at login",
      type: "checkbox",
      // A dev build would register the bare electron binary.
      enabled: app.isPackaged,
      checked: startAtLogin.get(),
      click: (item) => startAtLogin.set(item.checked),
    },
    { type: "separator" },
    {
      label: restart ? "Restarting server…" : "Restart server",
      icon: menuIcon("rotate-cw", dark),
      // An attached server (`pnpm dev`) isn't ours to stop.
      enabled: ownsServer && !restart,
      click: restartServer,
    },
    { type: "separator" },
    { label: "Quit", icon: menuIcon("power", dark), click: () => app.quit() },
  ]);
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

function setTrayIconStyle(style: TrayIconStyle): void {
  prefs = { ...prefs, trayIcon: style };
  try {
    writePrefs(app.getPath("userData"), prefs);
  } catch (error) {
    // The choice still applies until the shell quits.
    console.error(`[${BRAND.id}] could not save the tray icon choice:`, error);
  }
  tray?.setImage(trayIcon(style, badge.count > 0));
  refreshTrayMenu();
}

function createTray(): Tray {
  const t = new Tray(trayIcon(prefs.trayIcon, badge.count > 0));
  t.setToolTip(productName);
  t.setContextMenu(buildTrayMenu());
  t.on("click", showWindow);
  return t;
}

/** Resolves to the index of the button pressed: 0 is Quit. */
async function reportStartFailure(error: unknown): Promise<number> {
  const logs = error instanceof ServerStartError ? error.logs : String(error);
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: productName,
    message: `${productName} could not start its server`,
    detail: `${error instanceof Error ? error.message : ""}\n\n${logs}`.trim(),
    buttons: ["Quit", "Open log folder"],
    defaultId: 0,
  });
  if (response === 1) await shell.openPath(app.getPath("logs"));
  return response;
}

const serverOptions: ServerOptions = {
  port,
  bundle,
  webDist,
  attachOnly: devUrl !== null,
  onUnexpectedExit(details) {
    dialog.showErrorBox(`${productName} server stopped`, details);
    app.exit(1);
  },
};

/** Stops the server we run and starts it again, then reloads the window onto the new one. */
function restartServer(): void {
  if (!ownsServer || restart) return;
  const old = server;
  // The window keeps showing the board, which reconnects by itself; until then nothing is served.
  server = null;
  restart = (async () => {
    try {
      await old?.stop();
      const next = await connectServer(serverOptions);
      // Attaching means something still answers on the port (the old server not gone yet); there is nothing of ours to run.
      if (!next.owned && !quitting) {
        throw new ServerStartError(`The old server is still answering on port ${port}; it did not restart.`, "");
      }
      if (quitting) {
        await next.stop();
        return;
      }
      server = next;
      void window?.loadURL(withToken(boardUrl(), "hash"));
    } catch (error) {
      // Quitting mid-restart isn't a failure to report. Otherwise the tray stays, so Restart server can try again.
      if (!quitting && (await reportStartFailure(error)) === 0) app.quit();
    } finally {
      restart = null;
      refreshTrayMenu();
    }
  })();
  refreshTrayMenu();
}

async function start(): Promise<void> {
  tray = createTray();
  try {
    server = await connectServer(serverOptions);
    ownsServer = server.owned;
  } catch (error) {
    // Quitting from the tray mid-startup kills the server; that isn't a failure to report.
    if (!quitting) await reportStartFailure(error);
    app.exit(quitting ? 0 : 1);
    return;
  }
  refreshTrayMenu();
  window = createWindow(showRequested || !process.argv.includes(HIDDEN_ARG));
}

if (app.requestSingleInstanceLock()) {
  app.setAppUserModelId(`com.${BRAND.id}.desktop${sandbox ? ".sandbox" : ""}`);
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  // Without a listener Electron quits when the last window closes; we live in the tray.
  app.on("window-all-closed", () => {});
  // The board reports its light/dark/system choice; "system" lets nativeTheme follow the OS itself.
  ipcMain.on(SET_THEME_CHANNEL, (event, theme: unknown) => {
    const sender = event.senderFrame?.url ?? "";
    if (!isDesktopTheme(theme) || decideNavigation(sender, boardUrl()) !== "allow") return;
    nativeTheme.themeSource = theme;
  });
  // Only the board page may ask for notifications and badges.
  const fromBoard = (event: Electron.IpcMainEvent) =>
    decideNavigation(event.senderFrame?.url ?? "", boardUrl()) === "allow";
  ipcMain.on(NOTIFY_CHANNEL, (event, value: unknown) => {
    const notification = parseDesktopNotification(value);
    if (!notification || !fromBoard(event) || !Notification.isSupported()) return;
    const toast = new Notification({ title: notification.title, body: notification.body, icon: appIcon() });
    shown.add(toast);
    // Windows doesn't always report a toast that timed out into the Action Center as closed.
    if (shown.size > MAX_SHOWN) shown.delete(shown.values().next().value!);
    toast.on("click", () => {
      shown.delete(toast);
      showWindow();
      window?.webContents.send(NOTIFICATION_CLICK_CHANNEL, notification);
    });
    toast.on("close", () => shown.delete(toast));
    toast.on("failed", () => shown.delete(toast));
    toast.show();
  });
  ipcMain.on(SET_BACKGROUND_CHANNEL, (event, value: unknown) => {
    const color = parseBackgroundColor(value);
    if (!color || !fromBoard(event) || color === pageBackground) return;
    pageBackground = color;
    // Hidden windows catch up on "show" (see createWindow).
    if (window?.isVisible()) syncTitleBar(window, nativeTheme.shouldUseDarkColors, pageBackground);
  });
  ipcMain.on(SET_BADGE_CHANNEL, (event, value: unknown) => {
    const next = parseDesktopBadge(value);
    if (next && fromBoard(event)) applyBadge(next);
  });
  nativeTheme.on("updated", () => {
    // Hidden windows catch up on "show" (see createWindow).
    if (window?.isVisible()) syncTitleBar(window, nativeTheme.shouldUseDarkColors, pageBackground);
    // The menu's icons are drawn for a light or a dark menu.
    refreshTrayMenu();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    // A restart in flight stops the server it started once it sees we're quitting; wait for that.
    if (restart) {
      event.preventDefault();
      window?.hide();
      void restart.finally(() => app.quit());
      return;
    }
    if (!server?.owned) return;
    const owned = server;
    server = null;
    event.preventDefault();
    // The graceful stop can take a few seconds; don't leave a window that looks frozen meanwhile.
    window?.hide();
    void owned.stop().finally(() => app.quit());
  });
  void app.whenReady().then(start);
} else {
  app.quit();
}
