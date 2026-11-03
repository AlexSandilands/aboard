import { desktopBridge } from "./desktopBridge";

let windowHidden = false;
let subscribed = false;
const listeners = new Set<() => void>();

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  desktopBridge()?.onWindowHidden?.((hidden) => {
    windowHidden = hidden;
    for (const listener of listeners) listener();
  });
}

/**
 * Whether nobody can see the page: a background tab, or the desktop window in the tray or minimised. The shell keeps a
 * hidden page running, so `document.hidden` alone stays false there.
 */
export function pageHidden(): boolean {
  subscribe();
  return document.hidden || windowHidden;
}

/** Calls `listener` whenever `pageHidden()` may have changed. Returns the unsubscribe function. */
export function onPageHiddenChange(listener: () => void): () => void {
  subscribe();
  listeners.add(listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    listeners.delete(listener);
    document.removeEventListener("visibilitychange", listener);
  };
}
