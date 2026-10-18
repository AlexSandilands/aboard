import { BRAND, Health, type DesktopBadge, type DesktopNotification, type DesktopTheme } from "@repo/contracts";

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

/** Board pages stay in the window; links elsewhere (PRs, Jira, T3 Code threads) go to the OS. */
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
