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

export type KeybindingCommand = "palette.open" | "idea.new" | "settings.open" | "back";

/** What a binding's `when` can look at. Built per key event from the stores and the event target. */
export interface KeybindingContext {
  /** Focus is in a text field. */
  editableFocus: boolean;
  /** Focus is inside a menu, listbox or dialog, which handle their own keys. */
  popupFocus: boolean;
  /** The palette or a dialog is open. */
  overlayOpen: boolean;
  /** Escape has somewhere to go back to: the task panel is open, or Settings is showing. */
  canGoBack: boolean;
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
  { key: "mod+,", command: "settings.open", when: (c) => !c.overlayOpen },
  { key: "escape", command: "back", when: (c) => c.canGoBack && noFocusClaim(c) },
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
