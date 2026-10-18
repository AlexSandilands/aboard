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
import { appIcon, trayIcon } from "./icon.ts";
import {
  NOTIFICATION_CLICK_CHANNEL,
  NOTIFY_CHANNEL,
  SET_BACKGROUND_CHANNEL,
  SET_BADGE_CHANNEL,
  SET_THEME_CHANNEL,
} from "./ipc.ts";
import { ServerStartError, connectServer, type BoardServer } from "./server.ts";
import {
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
    webPreferences: { sandbox: true, contextIsolation: true, preload: join(here, "preload.cjs") },
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
  tray?.setImage(trayIcon(next.count > 0));
  tray?.setToolTip(next.count > 0 ? `${productName}: ${next.description}` : productName);
}

function showWindow(): void {
  if (!server) {
    showRequested = true;
    return;
  }
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
    { label: `Open ${productName}`, click: showWindow },
    {
      label: "Copy MCP URL",
      enabled: server !== null,
      // The API server's URL even in dev, where the window shows the Vite server instead.
      click: () => server && clipboard.writeText(withToken(`${server.url}/mcp`, "query")),
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
  const t = new Tray(trayIcon());
  t.setToolTip(productName);
  t.setContextMenu(buildTrayMenu());
  t.on("click", showWindow);
  return t;
}

async function reportStartFailure(error: unknown): Promise<void> {
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
        dialog.showErrorBox(`${productName} server stopped`, details);
        app.exit(1);
      },
    });
  } catch (error) {
    // Quitting from the tray mid-startup kills the server; that isn't a failure to report.
    if (!quitting) await reportStartFailure(error);
    app.exit(quitting ? 0 : 1);
    return;
  }
  tray.setContextMenu(buildTrayMenu());
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
  });
  app.on("before-quit", (event) => {
    quitting = true;
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
