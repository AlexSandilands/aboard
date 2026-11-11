export const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);

/** True when a key event comes from somewhere the user is typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * True inside an open menu, listbox, dialog or other popup, which handle their own Escape. The Settings and Stats
 * windows (`[data-app-modal]`) are dialogs too but don't count: their pages take the app's shortcuts as a page does.
 */
export function isInsidePopup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(POPUP_SELECTOR) !== null;
}
const POPUP_SELECTOR = [
  '[role="dialog"]:not([data-app-modal])',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot$="-popup"]:not([data-app-modal])',
].join(",");

/** True on the control that is recording a new shortcut, which gets every key (the app's own shortcuts stand down). */
export function isRecordingShortcut(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-recording-shortcut]") !== null;
}
