import {
  resolveKeybindings,
  evaluateWhen,
  type KeybindingCommand,
  type KeybindingContext,
  type ResolvedKeybinding,
} from "@repo/contracts";

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

/** An event's key as shortcuts name it: lowercase, with the two keys that would break `mod+k` syntax spelled out. */
function shortcutKey(eventKey: string): string {
  const key = eventKey.toLowerCase();
  return key === " " ? "space" : key === "+" ? "plus" : key;
}

/** True when the event is exactly this shortcut: the key (any case) and no extra modifiers. */
export function matchesShortcut(event: KeyEventLike, shortcut: string, isMac: boolean): boolean {
  const parsed = parseShortcut(shortcut);
  if (shortcutKey(event.key) !== parsed.key) return false;
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  const otherPressed = isMac ? event.ctrlKey : event.metaKey;
  return modPressed === parsed.mod && !otherPressed && event.shiftKey === parsed.shift && event.altKey === parsed.alt;
}

const MODIFIER_KEYS = new Set(["control", "meta", "shift", "alt", "altgraph", "os", "capslock", "dead"]);

/**
 * The shortcut an event spells, for recording a new one. Null while only modifiers are down, and for Ctrl on macOS
 * or Cmd elsewhere, which `matchesShortcut` never accepts.
 */
export function shortcutFromEvent(event: KeyEventLike, isMac: boolean): string | null {
  const key = shortcutKey(event.key);
  if (MODIFIER_KEYS.has(key)) return null;
  if (isMac ? event.ctrlKey : event.metaKey) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return [mod && "mod", event.shiftKey && "shift", event.altKey && "alt", key].filter(Boolean).join("+");
}

const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  plus: "+",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Del",
  tab: "Tab",
};

/** `mod+k` as people read it: `Ctrl+K`, or `⌘K` on macOS. */
export function formatShortcut(shortcut: string, isMac: boolean): string {
  const { key, mod, shift, alt } = parseShortcut(shortcut);
  const label = KEY_LABELS[key] ?? key.toUpperCase();
  const parts = isMac
    ? [alt && "⌥", shift && "⇧", mod && "⌘", label]
    : [mod && "Ctrl", alt && "Alt", shift && "Shift", label];
  return parts.filter(Boolean).join(isMac ? "" : "+");
}

const DEFAULT_BINDINGS = resolveKeybindings();

/** Commands that run synchronously. Others wait to see whether something nearer the focus claimed the key. */
export function runsImmediately(
  command: KeybindingCommand,
  bindings: readonly ResolvedKeybinding[] = DEFAULT_BINDINGS,
) {
  return bindings.find((binding) => binding.command === command)?.immediate ?? false;
}

/** The command for this key event, or null. When several bindings match, the last one wins. */
export function resolveCommand(
  event: KeyEventLike,
  context: KeybindingContext,
  isMac: boolean,
  bindings: readonly ResolvedKeybinding[] = DEFAULT_BINDINGS,
): KeybindingCommand | null {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]!;
    if (matchesShortcut(event, binding.key, isMac) && evaluateWhen(binding.condition, context)) return binding.command;
  }
  return null;
}
