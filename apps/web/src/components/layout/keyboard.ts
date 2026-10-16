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
  return (
    target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot$="-popup"]') !== null
  );
}

/** The fields of a `KeyboardEvent` the matcher reads, so it can run without a DOM. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ParsedShortcut {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** Parses `"mod+k"`, `"shift+n"` or `"escape"`. `mod` is Cmd on macOS and Ctrl elsewhere. */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return { key, mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
}

/** True when the event is exactly this shortcut: the key (any case) and no extra modifiers. */
export function matchesShortcut(event: KeyEventLike, shortcut: string, isMac: boolean): boolean {
  const parsed = parseShortcut(shortcut);
  if (event.key.toLowerCase() !== parsed.key) return false;
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherPressed = isMac ? event.ctrlKey : event.metaKey;
  return modPressed === parsed.mod && !otherPressed && event.shiftKey === parsed.shift && event.altKey === parsed.alt;
}

export type KeybindingCommand = "palette.open" | "idea.new" | "panel.close";

/** What a binding's `when` can look at. Built per key event from the stores and the event target. */
export interface KeybindingContext {
  /** Focus is in a text field. */
  editableFocus: boolean;
  /** Focus is inside a menu, listbox or dialog, which handle their own keys. */
  popupFocus: boolean;
  /** The palette or a settings dialog is open. */
  overlayOpen: boolean;
  /** The task detail panel is open. */
  panelOpen: boolean;
  paletteOpen: boolean;
}

export interface Keybinding {
  key: string;
  command: KeybindingCommand;
  when?: (context: KeybindingContext) => boolean;
}

const noFocusClaim = (c: KeybindingContext) => !c.overlayOpen && !c.editableFocus && !c.popupFocus;

/** Shaped like t3code's keybindings so user-configurable ones can replace this table later. */
export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { key: "mod+k", command: "palette.open" },
  { key: "n", command: "idea.new", when: noFocusClaim },
  { key: "escape", command: "panel.close", when: (c) => c.panelOpen && noFocusClaim(c) },
];

/** Commands run synchronously. Others wait to see whether something nearer the focus claimed the key. */
export function runsImmediately(command: KeybindingCommand): boolean {
  return command === "palette.open";
}

/** The command for this key event, or null. When several bindings match, the last one wins. */
export function resolveCommand(
  event: KeyEventLike,
  context: KeybindingContext,
  isMac: boolean,
  bindings: readonly Keybinding[] = DEFAULT_KEYBINDINGS,
): KeybindingCommand | null {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]!;
    if (matchesShortcut(event, binding.key, isMac) && (binding.when?.(context) ?? true)) return binding.command;
  }
  return null;
}
