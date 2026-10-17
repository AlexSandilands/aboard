import { storageKey, type InboxNotification } from "@repo/contracts";
import { desktopBridge } from "~/lib/desktopBridge";
import { deliveryTarget, isDeliveringTab, reduceTabs, type TabMessage, type TabState } from "./notifications.logic";

/** What a click on a popup opens: the task, and the notification is read. */
export type OpenNotification = (n: Pick<InboxNotification, "id" | "taskId">) => void;

let opener: OpenNotification | null = null;

/** The window's way to open a task from a popup; set while the board is mounted. */
export function setNotificationOpener(next: OpenNotification | null): void {
  opener = next;
}

const TAB_ID = crypto.randomUUID();
let tabs: TabState = { current: null };
let holdsLock = true;

const permission = (): NotificationPermission | "unsupported" =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

/**
 * Keeps this tab in step with the others about which one delivers browser notifications (see `reduceTabs`).
 * Returns the cleanup.
 */
export function startTabCoordination(): () => void {
  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(storageKey("notification-tabs"));
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes no target origin
  const post = (type: TabMessage["type"]) => channel?.postMessage({ type, tab: TAB_ID } satisfies TabMessage);
  const claim = () => {
    tabs = { current: TAB_ID };
    post("focus");
  };

  // Without Web Locks every tab counts as the holder, so an unclaimed browser may pop up once per tab.
  holdsLock = !navigator.locks;
  let releaseLock: (() => void) | null = null;
  void navigator.locks?.request(
    storageKey("notification-tab-lock"),
    () =>
      new Promise<void>((resolve) => {
        holdsLock = true;
        releaseLock = resolve;
      }),
  );

  if (channel) {
    channel.addEventListener("message", (event: MessageEvent<TabMessage>) => {
      const message = event.data;
      tabs = reduceTabs(tabs, message);
      // A new tab asking who delivers: the one that does answers.
      if (message.type === "hello" && tabs.current === TAB_ID) post("current");
    });
  }
  if (document.hasFocus()) claim();
  else post("hello");
  const onBye = () => post("bye");
  window.addEventListener("focus", claim);
  window.addEventListener("pagehide", onBye);
  return () => {
    window.removeEventListener("focus", claim);
    window.removeEventListener("pagehide", onBye);
    onBye();
    releaseLock?.();
    channel?.close();
  };
}

/** Shows the OS popup for a new notification, where `deliveryTarget` says one belongs. */
export function deliverNotification(notification: InboxNotification, popup: boolean): void {
  const bridge = desktopBridge();
  const target = deliveryTarget({
    popup,
    desktop: bridge !== null,
    focused: document.hasFocus(),
    deliveringTab: isDeliveringTab(tabs, TAB_ID, holdsLock),
    permission: permission(),
  });
  if (target === "desktop") {
    const { id, title, body, taskId } = notification;
    bridge?.notify({ id, title, body, taskId });
  } else if (target === "browser") {
    // The tag lets the OS replace a popup it already shows for the same notification.
    const popupNotification = new Notification(notification.title, { body: notification.body, tag: notification.id });
    popupNotification.addEventListener("click", () => {
      window.focus();
      popupNotification.close();
      opener?.(notification);
    });
  }
}
