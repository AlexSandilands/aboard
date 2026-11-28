import { z } from "zod";
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
  /**
   * A settings target a click opens instead (`board.desktop`). Only the shell's own notifications (an update) set
   * it; they aren't board notifications, so there is nothing to mark read.
   */
  settingsTarget?: string;
}

/**
 * How this install gets updates. `self-update`: the Windows installer and the AppImage download and install new
 * versions themselves. `notice-only`: package-manager installs (.deb, .rpm, tarball, pacman, AUR) are only told a
 * new version is out. `disabled`: dev and sandbox shells and builds from source; `disabledReason` says which.
 */
export const DesktopUpdateMode = z.enum(["self-update", "notice-only", "disabled"]);
export type DesktopUpdateMode = z.infer<typeof DesktopUpdateMode>;

/**
 * Where an update stands. `idle` before the first check; `ready` once a self-update is downloaded; `available` when a
 * notice-only install learns of a newer version; `error` when the last check failed.
 */
export const DesktopUpdateStatus = z.enum([
  "idle",
  "checking",
  "up-to-date",
  "downloading",
  "ready",
  "installing",
  "available",
  "error",
]);
export type DesktopUpdateStatus = z.infer<typeof DesktopUpdateStatus>;

/** The shell's one update state, which the tray, Settings and the title-bar pill all show. */
export const DesktopUpdateState = z.object({
  mode: DesktopUpdateMode,
  disabledReason: z.string().nullable(),
  /** The running version. */
  currentVersion: z.string(),
  /** Whether the shell checks by itself (hourly). Check now works either way. */
  autoCheck: z.boolean(),
  status: DesktopUpdateStatus,
  /** The newer version being downloaded, ready or available. */
  version: z.string().nullable(),
  /** Download progress, 0-100, while downloading. */
  percent: z.number().nullable(),
  /** When the last check finished (ms since the epoch), successful or not. */
  checkedAt: z.number().nullable(),
  /** Why the last check or install failed, in a sentence. */
  error: z.string().nullable(),
  /** On a notice-only install, how to get the new version: through pacman, or a download from the release page. */
  noticeVia: z.enum(["pacman", "download"]).nullable(),
});
export type DesktopUpdateState = z.infer<typeof DesktopUpdateState>;

/**
 * A published release as the release notes dialog shows it. The shell reads the GitHub release and splits its body
 * with `splitReleaseNotes`: `highlights` is the user-facing Markdown (empty when the release has none), `details` the
 * generated list of pull requests.
 */
export const DesktopRelease = z.object({
  /** `1.4.2`, without the tag's `v`. */
  version: z.string(),
  name: z.string(),
  /** ISO 8601, or null when GitHub gives none. */
  publishedAt: z.string().nullable(),
  /** The release page. */
  url: z.string(),
  highlights: z.string(),
  details: z.string(),
});
export type DesktopRelease = z.infer<typeof DesktopRelease>;

/**
 * Every published release up to the running version, newest first; or why they couldn't be read, with the page that
 * lists them on GitHub instead.
 */
export const DesktopReleaseList = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), releases: z.array(DesktopRelease) }),
  z.object({ ok: z.literal(false), error: z.string(), url: z.string().nullable() }),
]);
export type DesktopReleaseList = z.infer<typeof DesktopReleaseList>;

/**
 * Whether the release notes dialog should open by itself. `since` is the version the user last saw when this launch is
 * the first on a newer one (the releases after it, up to `currentVersion`, are new); null otherwise: a fresh install,
 * the same version, updates turned off by the build, or `showReleaseNotes` off.
 */
export const DesktopWhatsNew = z.object({
  currentVersion: z.string(),
  since: z.string().nullable(),
  /** Show the release notes after an update (prefs; the dialog's checkbox and the Settings switch). */
  showReleaseNotes: z.boolean(),
});
export type DesktopWhatsNew = z.infer<typeof DesktopWhatsNew>;

/**
 * The fields of an entry in GitHub's `GET /repos/{owner}/{repo}/releases` that the shell reads for the release notes;
 * the rest is ignored. Here rather than in the shell, which has no zod of its own.
 */
export const GitHubApiRelease = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string(),
});

/** A release body split into what the dialog shows first and the generated list it folds away. */
export interface ReleaseNotesParts {
  highlights: string;
  details: string;
}

/** A line that starts the generated part: `## Details`, or `## What's Changed` in releases from before the format. */
const DETAILS_HEADING = /^##[ \t]+(details|what['’]s changed)[ \t]*#*[ \t]*$/im;
const HIGHLIGHTS_HEADING = /^##[ \t]+highlights[ \t]*#*[ \t]*$/im;

/**
 * Splits a release body (docs/features/releases.md: `## Highlights`, then `## Details`) at its Details heading. The
 * headings themselves are dropped. A body with neither heading is all highlights, as a hand-written one would be.
 */
export function splitReleaseNotes(body: string | null | undefined): ReleaseNotesParts {
  const text = (body ?? "").replace(/\r\n?/g, "\n");
  const details = DETAILS_HEADING.exec(text);
  const head = details ? text.slice(0, details.index) : text;
  const tail = details ? text.slice(details.index + details[0].length) : "";
  const highlights = HIGHLIGHTS_HEADING.exec(head);
  return {
    highlights: (highlights ? head.slice(highlights.index + highlights[0].length) : head).trim(),
    details: tail.trim(),
  };
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
  /**
   * The page's background as `#rrggbb`, so the window behind it and the title bar match the board's theme. Optional:
   * a shell from before themes has no such method, and the page can be newer than the shell it runs in.
   */
  setBackgroundColor?(color: string): void;
  /** Shows an OS notification. Clicking it brings the window forward and calls the `onNotificationClick` listeners. */
  notify(notification: DesktopNotification): void;
  setBadge(badge: DesktopBadge): void;
  /** Returns the unsubscribe function. */
  onNotificationClick(listener: (notification: DesktopNotification) => void): () => void;
  /**
   * Updates of the desktop app itself. Optional, like `setBackgroundColor`: a shell from before updates has none.
   * `getUpdateState` resolves to the current state; `onUpdateState` gets every change after that.
   */
  getUpdateState?(): Promise<DesktopUpdateState>;
  /** Returns the unsubscribe function. */
  onUpdateState?(listener: (state: DesktopUpdateState) => void): () => void;
  /** Checks now, whether or not automatic checks are on. */
  checkForUpdates?(): void;
  /** Stops the server, installs the downloaded update and restarts the app. Only does something while `ready`. */
  installUpdate?(): void;
  setAutoCheckUpdates?(enabled: boolean): void;
  /** Opens the release page of the newer version (or the releases list) in the browser. */
  openReleaseNotes?(): void;
  /**
   * The release notes dialog. Optional, like the update methods: a shell from before release notes has none, and
   * the page then never opens the dialog. `getWhatsNew` says whether this launch should open it (see
   * `DesktopWhatsNew`); `listReleases` fetches the published releases from GitHub, once per run.
   */
  getWhatsNew?(): Promise<DesktopWhatsNew>;
  listReleases?(): Promise<DesktopReleaseList>;
  /**
   * The dialog was closed: the running version counts as seen, so it doesn't open again until the next update.
   * `stopShowing` (the dialog's "Don't show after updates") also turns `showReleaseNotes` off.
   */
  dismissWhatsNew?(stopShowing: boolean): void;
  setShowReleaseNotes?(enabled: boolean): void;
}

/** The ports the user's own board runs on (`pnpm dev`, the desktop app). A sandbox never uses them. */
export const DEFAULT_SERVER_PORT = 4317;
export const DEFAULT_WEB_PORT = 5317;
/**
 * A runner's port (docs/features/remote-machines.md). Not the board's, so a machine with the desktop app can run a
 * runner too without either locking the other out.
 */
export const DEFAULT_RUNNER_PORT = 4318;

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
  if (!/^([a-z]:)?\//i.test(dir)) return { error: `the sandbox home ${home || "(empty)"} is not an absolute path` };
  if (dir === real || dir.startsWith(`${real}/`)) {
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
