/** True when a key event comes from somewhere the user is typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** True inside an open menu, listbox, dialog or other popup, which handle their own Escape. */
export function isInsidePopup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot$="-popup"]') !== null;
}
