import {
  DEFAULT_KEYBINDINGS,
  type KeybindingCommand,
  type KeybindingOverride,
  type KeybindingOverrides,
  type ResolvedKeybinding,
  parseWhen,
  whenOverlaps,
} from "@repo/contracts";
import { parseShortcut } from "~/components/layout/keyboard.logic";

/**
 * The overrides with one command's key and/or `when` changed. A value equal to the default is dropped, and a command
 * left with nothing to override is removed, so the stored map only names what the user really changed.
 */
export function withOverride(
  overrides: KeybindingOverrides,
  command: KeybindingCommand,
  patch: KeybindingOverride,
): KeybindingOverrides {
  const defaults = DEFAULT_KEYBINDINGS[command];
  const merged: KeybindingOverride = { ...overrides[command], ...patch };
  const next: KeybindingOverride = {
    ...(merged.key !== undefined && merged.key.toLowerCase() !== defaults.key ? { key: merged.key.toLowerCase() } : {}),
    ...(merged.when !== undefined && merged.when.trim() !== defaults.when ? { when: merged.when.trim() } : {}),
  };
  const others = withoutOverride(overrides, command);
  return Object.keys(next).length === 0 ? others : { ...others, [command]: next };
}

/** The overrides without this command. */
export function withoutOverride(overrides: KeybindingOverrides, command: KeybindingCommand): KeybindingOverrides {
  const { [command]: _removed, ...others } = overrides;
  return others;
}

/** "Also New task" / "Also New task and Open Settings", for the commands sharing a key with this one. */
export function describeConflict(others: readonly KeybindingCommand[]): string {
  const titles = others.map((command) => DEFAULT_KEYBINDINGS[command].title);
  const list = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}` : titles[0];
  return `Same key as ${list}: where both apply, the one listed later wins.`;
}

const EDITABLE_FOCUS = parseWhen("editableFocus");

/**
 * True when typing this key into a text field would run the command: a bare character (no Ctrl/Cmd or Alt) under a
 * `when` that can hold while a field has focus. Escape and the like are fine; they type nothing.
 */
export function triggersWhileTyping(binding: ResolvedKeybinding): boolean {
  const { key, mod, alt } = parseShortcut(binding.key);
  if (mod || alt || key.length !== 1 || !EDITABLE_FOCUS.ok) return false;
  return whenOverlaps(binding.condition, EDITABLE_FOCUS.node);
}

/** The note under a command that would trigger while typing. */
export const TYPING_WARNING = "Typing this key in a text field runs it. Add !editableFocus to When to stop that.";
