import { badgeText, type InboxNotification, type NotificationKind, type NotificationList } from "@repo/contracts";

/** The inbox keeps this many in the cache, the same as the server's default page. */
const INBOX_LIMIT = 100;

/** A notification the server just made, at the top of the cached inbox. The server's count replaces ours. */
export function withCreated(list: NotificationList, created: InboxNotification, unread: number): NotificationList {
  if (list.items.some((n) => n.id === created.id)) return { ...list, unread };
  return { items: [created, ...list.items].slice(0, INBOX_LIMIT), unread };
}

/** The inbox narrowed to one kind; null shows everything. */
export function filterByKind(
  items: ReadonlyArray<InboxNotification>,
  kind: NotificationKind | null,
): InboxNotification[] {
  return kind ? items.filter((n) => n.kind === kind) : [...items];
}

/** The kinds present in the inbox, so the filter only offers what there is to see. */
export function kindsPresent(items: ReadonlyArray<InboxNotification>): NotificationKind[] {
  return [...new Set(items.map((n) => n.kind))];
}

/** "1 unread notification", read aloud for the bell and the taskbar overlay. */
export function unreadDescription(count: number): string {
  return count === 1 ? "1 unread notification" : `${count} unread notifications`;
}

/** What the bell's badge says: the count, "9+" past nine, nothing at zero. */
export const bellText = badgeText;

export type DeliveryTarget = "desktop" | "browser";

export interface DeliveryContext {
  /** The server's verdict: false during quiet hours. */
  popup: boolean;
  /** Running inside the desktop app (the preload bridge exists). */
  desktop: boolean;
  /** This window is the one the user is looking at. */
  focused: boolean;
  /** This tab is the one browser notifications come from. */
  deliveringTab: boolean;
  permission: NotificationPermission | "unsupported";
}

/**
 * Where an OS popup for a new notification should show, if anywhere. Nothing pops up while the user is looking at the
 * board (the bell has it). The desktop app uses the shell; a browser tab uses the Notification API once permitted,
 * and only the one delivering tab does, so several tabs don't each pop up the same thing.
 */
export function deliveryTarget(c: DeliveryContext): DeliveryTarget | null {
  if (!c.popup || c.focused) return null;
  if (c.desktop) return "desktop";
  return c.deliveringTab && c.permission === "granted" ? "browser" : null;
}

// ── Which tab delivers ───────────────────────────────────────────────────

/**
 * Tabs agree on one deliverer by announcing focus: the tab used last delivers, as the one the user is likely to come
 * back to. With none announced yet, the tab holding the Web Lock does.
 */
export interface TabState {
  current: string | null;
}

export interface TabMessage {
  type: "focus" | "bye" | "current" | "hello";
  tab: string;
}

export function reduceTabs(state: TabState, message: TabMessage): TabState {
  switch (message.type) {
    case "focus":
      return { current: message.tab };
    case "current":
      return state.current === null ? { current: message.tab } : state;
    case "bye":
      return state.current === message.tab ? { current: null } : state;
    case "hello":
      return state;
  }
}

export function isDeliveringTab(state: TabState, me: string, holdsLock: boolean): boolean {
  return state.current === me || (state.current === null && holdsLock);
}

/** The window the mute setting follows, in words; Autopilot's settings own it. */
export function describeQuietHours(quiet: { enabled: boolean; start: string; end: string }): string {
  if (!quiet.enabled || quiet.start === quiet.end)
    return "Quiet hours are off in Autopilot's settings, so nothing is muted yet.";
  return `Quiet hours are ${quiet.start} to ${quiet.end} (set in Autopilot's settings).`;
}
