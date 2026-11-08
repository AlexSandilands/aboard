import {
  BRAND,
  Health,
  type DesktopBadge,
  type DesktopNotification,
  type DesktopTheme,
  type DesktopUpdateMode,
  type DesktopUpdateState,
  type GitHubRepository,
} from "@repo/contracts";

/** True when a `/api/health` body comes from our server, not some other app holding the port. */
export function isOwnHealth(body: unknown): boolean {
  const parsed = Health.safeParse(body);
  return parsed.success && parsed.data.id === BRAND.id;
}

const DESKTOP_THEMES = new Set<unknown>(["light", "dark", "system"] satisfies DesktopTheme[]);

/** Validates a theme sent over IPC by the page. */
export function isDesktopTheme(value: unknown): value is DesktopTheme {
  return DESKTOP_THEMES.has(value);
}

/** The page's background colour as the board sends it: `#rrggbb` only, lower-cased. */
export function parseBackgroundColor(value: unknown): string | null {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

/** Schemes we hand to the OS. Anything else (file:, javascript:, ms-* handlers…) is dropped. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "t3code:"]);

export type NavigationDecision = "allow" | "external" | "block";

/** Board pages stay in the window; links elsewhere (PRs, tickets, T3 Code threads) go to the OS. */
export function decideNavigation(target: string, boardUrl: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if (url.origin === new URL(boardUrl).origin) return "allow";
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? "external" : "block";
}

/**
 * Whether a frame inside the board may navigate. The board's only frames are sandboxed agent art (the social
 * network's feed), which loads from srcdoc and must never go anywhere else: a document it navigated to would shed the
 * art's CSP. So a sub-frame may load only its srcdoc or a blank page.
 */
export function allowSubFrameNavigation(target: string): boolean {
  return target === "about:srcdoc" || target === "about:blank";
}

/** Keeps the last `max` lines of a stream of output chunks, for error reports. */
export class LogTail {
  private lines: string[] = [];
  private partial = "";

  constructor(private readonly max = 40) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    this.lines.push(...parts);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  toString(): string {
    return [...this.lines, this.partial].filter(Boolean).join("\n");
  }
}

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

/** Validates a notification sent over IPC by the page; the shell shows only what it recognises. Long text is cut, not refused. */
export function parseDesktopNotification(value: unknown): DesktopNotification | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, title, body, taskId } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string") return null;
  // Ids are ours and short; a long one is not from the board.
  const checked = { id: text(id, 100), taskId: taskId === null ? null : text(taskId, 100) };
  if (checked.id === null || (taskId !== null && checked.taskId === null)) return null;
  return { id: checked.id, title: title.slice(0, 300), body: body.slice(0, 1000), taskId: checked.taskId };
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
/** A 32px badge PNG is a few hundred bytes; this leaves room and still refuses anything big. */
const MAX_OVERLAY_LENGTH = 50_000;

/** Validates the badge sent over IPC: a count, a description, and an overlay that really is a small PNG data URL. */
export function parseDesktopBadge(value: unknown): DesktopBadge | null {
  if (typeof value !== "object" || value === null) return null;
  const { count, description, overlay } = value as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 1_000_000) return null;
  const described = text(description, 200);
  if (described === null) return null;
  if (
    overlay !== null &&
    !(typeof overlay === "string" && overlay.length <= MAX_OVERLAY_LENGTH && PNG_DATA_URL.test(overlay))
  ) {
    return null;
  }
  return { count, description: described, overlay };
}

/**
 * One argument of a desktop entry's `Exec` line. The spec reserves spaces, quotes and shell characters: such an
 * argument goes in double quotes, with `"`, `` ` ``, `$` and `\` escaped inside them. The key is also a string value,
 * whose own escaping doubles every backslash after that, and a lone `%` would start a field code.
 */
function desktopExecArg(arg: string): string {
  const literal = arg.replaceAll("%", "%%");
  const quoted = /[\s"'\\><~|&;$*?#()`]/.test(literal) ? `"${literal.replace(/["`$\\]/g, "\\$&")}"` : literal;
  return quoted.replaceAll("\\", "\\\\");
}

/** The XDG autostart entry that starts the app at login on Linux, where Electron has no login items. */
export function linuxAutostartEntry(name: string, exe: string, args: readonly string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${[exe, ...args].map(desktopExecArg).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Release versions are dates (`2026.11.6`, see scripts/release-version.ts); anything else is a build from source. */
const RELEASE_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;

export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version);
}

/** Whether `candidate` is a later release than `current`. Anything that isn't a release version never is. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = RELEASE_VERSION.exec(candidate)?.slice(1).map(Number);
  const b = RELEASE_VERSION.exec(current)?.slice(1).map(Number);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export interface UpdateEnvironment {
  packaged: boolean;
  sandbox: boolean;
  platform: NodeJS.Platform;
  /** `APPIMAGE`: the AppImage file the app runs from, set by the AppImage runtime. */
  appImage: string | undefined;
  version: string;
}

/**
 * How this install gets updates. Only the Windows installer and the AppImage replace themselves; a package manager's
 * files are never written over, so its installs are only told. Dev and sandbox shells and builds from source (whose
 * version isn't a release's) never check.
 */
export function updateMode(env: UpdateEnvironment): { mode: DesktopUpdateMode; reason: string | null } {
  if (env.sandbox) return { mode: "disabled", reason: "the sandbox" };
  if (!env.packaged) return { mode: "disabled", reason: "dev builds" };
  if (!isReleaseVersion(env.version)) return { mode: "disabled", reason: "builds from source" };
  if (env.platform === "win32") return { mode: "self-update", reason: null };
  if (env.platform === "linux") return { mode: env.appImage ? "self-update" : "notice-only", reason: null };
  return { mode: "disabled", reason: "this platform" };
}

/**
 * How a notice-only install gets the new version. electron-builder's .deb and .rpm say so in `resources/package-type`
 * but come from no repo, so both are a download, as is the tarball; the Arch packages (the tarball installed under
 * /opt/<id> on a system with pacman: `pacmanInstall`) update with pacman.
 */
export function noticeVia(packageType: string | null, pacmanInstall: boolean): "pacman" | "download" {
  return packageType === null && pacmanInstall ? "pacman" : "download";
}

export function initialUpdateState(
  mode: { mode: DesktopUpdateMode; reason: string | null },
  currentVersion: string,
  autoCheck: boolean,
  via: "pacman" | "download" | null,
): DesktopUpdateState {
  return {
    mode: mode.mode,
    disabledReason: mode.reason,
    currentVersion,
    autoCheck,
    status: "idle",
    version: null,
    percent: null,
    checkedAt: null,
    error: null,
    noticeVia: mode.mode === "notice-only" ? via : null,
  };
}

export type UpdateEvent =
  | { type: "checking" }
  | { type: "up-to-date"; at: number }
  | { type: "found"; version: string; at: number }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string; at: number }
  | { type: "installing" }
  | { type: "install-failed"; message: string }
  | { type: "auto-check"; enabled: boolean };

/** Statuses a check can't change: a download under way or done, or an install. */
const BUSY = new Set(["downloading", "ready", "installing"]);

/** The update state after an event from the updater (or the notice-only check, or the user). */
export function reduceUpdate(state: DesktopUpdateState, event: UpdateEvent): DesktopUpdateState {
  switch (event.type) {
    case "auto-check":
      return { ...state, autoCheck: event.enabled };
    case "checking":
      return BUSY.has(state.status) ? state : { ...state, status: "checking", error: null };
    case "up-to-date":
      if (BUSY.has(state.status)) return state;
      return { ...state, status: "up-to-date", version: null, percent: null, checkedAt: event.at, error: null };
    case "found":
      if (state.status === "ready" || state.status === "installing") return state;
      return state.mode === "self-update"
        ? { ...state, status: "downloading", version: event.version, percent: 0, checkedAt: event.at, error: null }
        : { ...state, status: "available", version: event.version, percent: null, checkedAt: event.at, error: null };
    case "progress":
      return state.status === "downloading"
        ? { ...state, percent: Math.max(0, Math.min(100, Math.floor(event.percent))) }
        : state;
    case "downloaded":
      if (state.status === "installing") return state;
      return { ...state, status: "ready", version: event.version, percent: null, error: null };
    case "error":
      // A ready update stays ready, and a version a notice-only install already knows of stays known: a later
      // check failing changes neither. The error is quiet, shown only in Settings.
      if (state.status === "ready" || state.status === "installing" || state.status === "available") return state;
      return { ...state, status: "error", version: null, percent: null, checkedAt: event.at, error: event.message };
    case "installing":
      return state.status === "ready" ? { ...state, status: "installing", error: null } : state;
    case "install-failed":
      return state.status === "installing" ? { ...state, status: "ready", error: event.message } : state;
  }
}

/** Errors that mean "no network" or "no feed yet" (the release's files still uploading). */
const OFFLINE =
  /\b(404|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_[A-Z_]+|fetch failed|socket hang up)\b/i;

/** A check's or download's failure as one sentence for Settings. */
export function describeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (OFFLINE.test(message)) return "Couldn't reach GitHub, or the release isn't up yet. Tries again within the hour.";
  const first = message.split("\n").find((line) => line.trim()) ?? "Unknown error";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** The `version:` of an electron-builder feed (`latest-linux.yml`), without a YAML parser. */
export function feedVersion(yaml: string): string | null {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yaml);
  return match?.[1] ?? null;
}

/** The release page of a version, or the list of releases. */
export function releaseNotesUrl(repo: GitHubRepository, version: string | null): string {
  const base = `https://github.com/${repo.owner}/${repo.repo}/releases`;
  return version ? `${base}/tag/v${version}` : base;
}

/** The feed a notice-only install reads: the latest release's, which GitHub redirects to. */
export function latestFeedUrl(repo: GitHubRepository): string {
  return `https://github.com/${repo.owner}/${repo.repo}/releases/latest/download/latest-linux.yml`;
}

/**
 * The Linux feed named by the app's `resources/app-update.yml`, the file electron-updater reads too, so both kinds of
 * install follow the same source: a `github` provider's latest release, or a `generic` provider's folder (a test
 * build's local feed). Null when the file is missing or names neither, and the caller falls back to BRAND's repo.
 */
export function noticeFeedUrl(appUpdateYml: string | null): string | null {
  if (!appUpdateYml) return null;
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, "m").exec(appUpdateYml)?.[1] ?? null;
  const provider = field("provider");
  if (provider === "github") {
    const owner = field("owner");
    const repo = field("repo");
    return owner && repo ? latestFeedUrl({ owner, repo }) : null;
  }
  const url = field("url");
  if (provider === "generic" && url && /^https?:\/\//.test(url)) return `${url.replace(/\/+$/, "")}/latest-linux.yml`;
  return null;
}

export type UpdateMenuIcon = "search" | "download" | "rocket" | "external-link";

/** The tray's update item for a state: what it says, its icon, and what clicking it does (null: disabled). */
export function updateMenuItem(state: DesktopUpdateState): {
  label: string;
  icon: UpdateMenuIcon;
  action: "check" | "install" | "notes" | null;
} {
  if (state.mode === "disabled") {
    return { label: `Updates off in ${state.disabledReason ?? "this build"}`, icon: "search", action: null };
  }
  switch (state.status) {
    case "checking":
      return { label: "Checking for updates…", icon: "search", action: null };
    case "downloading":
      return { label: `Downloading v${state.version}… ${state.percent ?? 0}%`, icon: "download", action: null };
    case "ready":
      return { label: `Restart to update to v${state.version}`, icon: "rocket", action: "install" };
    case "installing":
      return { label: "Installing the update…", icon: "rocket", action: null };
    case "available":
      return { label: `v${state.version} available: release notes`, icon: "external-link", action: "notes" };
    default:
      return { label: "Check for updates", icon: "search", action: "check" };
  }
}

/** The OS notification for a version, once: when it is ready, or found on a notice-only install. */
export function updateNotification(state: DesktopUpdateState): { title: string; body: string } | null {
  if (state.status === "ready") {
    return {
      title: `${BRAND.name} v${state.version} is ready`,
      body: "Restart to install it. Click to open Settings.",
    };
  }
  if (state.status === "available") {
    const how = state.noticeVia === "pacman" ? "Update it with pacman -Syu." : "Download it from the release page.";
    return { title: `${BRAND.name} v${state.version} is available`, body: how };
  }
  return null;
}
