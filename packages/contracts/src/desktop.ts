import { brandEnv } from "./brand.ts";

/** The web app's theme choice; the desktop shell styles the native window controls to match. */
export type DesktopTheme = "light" | "dark" | "system";

/** An OS notification the page asks the shell to show. */
export interface DesktopNotification {
  id: string;
  title: string;
  body: string;
  /** The task a click opens. */
  taskId: string | null;
}

/**
 * The unread count as the shell shows it: a number on the taskbar button and a dot on the tray icon. Windows has no
 * numeric badge API, only an overlay image, so the page draws one (`overlay`, a PNG data URL) and the shell applies it.
 */
export interface DesktopBadge {
  count: number;
  /** Read aloud by screen readers for the overlay, e.g. "3 unread notifications". */
  description: string;
  overlay: string | null;
}

/** API the desktop shell's preload exposes as `window.desktopBridge`. Absent in a plain browser. */
export interface DesktopBridge {
  setTheme(theme: DesktopTheme): void;
  /** Shows an OS notification. Clicking it brings the window forward and calls the `onNotificationClick` listeners. */
  notify(notification: DesktopNotification): void;
  setBadge(badge: DesktopBadge): void;
  /** Returns the unsubscribe function. */
  onNotificationClick(listener: (notification: DesktopNotification) => void): () => void;
}

/** The ports the user's own board runs on (`pnpm dev`, the desktop app). A sandbox never uses them. */
export const DEFAULT_SERVER_PORT = 4317;
export const DEFAULT_WEB_PORT = 5317;

/** What `pnpm sandbox --desktop` tells the shell about the sandbox it opens. */
export interface DesktopSandbox {
  /** The sandbox's throwaway home; the shell keeps its profile in here, so `pnpm sandbox stop` removes it. */
  home: string;
  serverPort: number;
  webPort: number;
}

/** Env var that makes the shell a sandbox shell. Its value is `DesktopSandbox.home`. */
export const DESKTOP_SANDBOX_ENV = brandEnv("DESKTOP_SANDBOX");

type Env = Record<string, string | undefined>;

/**
 * The environment for a shell opened on a sandbox: attach to its server and load its Vite, with none of the
 * user's own token, data dir or run-as-node setting inherited.
 */
export function desktopSandboxEnv(base: Env, sandbox: DesktopSandbox): Env {
  const env: Env = { ...base };
  delete env[brandEnv("TOKEN")];
  delete env[brandEnv("HOME")];
  // Terminals inside Electron apps (T3 Code, VS Code) export this, which would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  env[brandEnv("PORT")] = String(sandbox.serverPort);
  env[brandEnv("WEB_PORT")] = String(sandbox.webPort);
  env[brandEnv("DEV_URL")] = `http://127.0.0.1:${sandbox.webPort}/`;
  env[DESKTOP_SANDBOX_ENV] = sandbox.home;
  return env;
}

const normalizeDir = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

function portOf(value: string | undefined, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}

/**
 * Reads the sandbox the shell was opened on: null for a normal run, an error message when the environment would
 * point a sandbox shell at the user's real board (its ports or data dir) or isn't a complete sandbox setup.
 * The shell exits on an error instead of starting.
 */
export function readDesktopSandbox(env: Env, realHome: string): DesktopSandbox | { error: string } | null {
  const home = env[DESKTOP_SANDBOX_ENV];
  if (home === undefined) return null;
  const real = normalizeDir(realHome);
  const dir = normalizeDir(home);
  if (!home || dir === real || dir.startsWith(`${real}/`)) {
    return { error: `the sandbox home ${home || "(empty)"} is the real data dir` };
  }
  const serverPort = portOf(env[brandEnv("PORT")], DEFAULT_SERVER_PORT);
  const webPort = portOf(/^http:\/\/127\.0\.0\.1:(\d+)(?:\/|$)/.exec(env[brandEnv("DEV_URL")] ?? "")?.[1], 0);
  if (!webPort) return { error: `${brandEnv("DEV_URL")} must be the sandbox's Vite on 127.0.0.1` };
  if (serverPort === DEFAULT_SERVER_PORT || webPort === DEFAULT_WEB_PORT) {
    return { error: `the sandbox is on the real board's ports (${DEFAULT_SERVER_PORT}/${DEFAULT_WEB_PORT})` };
  }
  return { home, serverPort, webPort };
}
