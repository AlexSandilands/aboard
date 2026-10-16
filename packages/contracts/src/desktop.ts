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
