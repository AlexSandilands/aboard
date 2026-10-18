import {
  DEFAULT_KEYBINDINGS,
  KeybindingCommand,
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

/** A registry group's name as an id segment: "General" → `general`. */
function keybindingGroupSlug(group: string): string {
  return group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The sub-section id of a registry group: `keybindings.<slug>`, so a new group gets a section without wiring. */
export function keybindingSectionId(group: string): string {
  return `keybindings.${keybindingGroupSlug(group)}`;
}

export interface KeybindingGroup {
  /** The registry's heading for it: "General", "Navigation". */
  label: string;
  /** Its id segment, which its rows' ids are built on. */
  slug: string;
  /** The settings sub-section it is listed in. */
  sectionId: string;
}

/** The registry's groups in the order their first command appears. */
export function keybindingGroups(): KeybindingGroup[] {
  const labels = [...new Set(KeybindingCommand.options.map((command) => DEFAULT_KEYBINDINGS[command].group))];
  return labels.map((label) => ({ label, slug: keybindingGroupSlug(label), sectionId: keybindingSectionId(label) }));
}

/** True when the user has changed this command's key or condition (an override equal to the default is never stored). */
export function isCustomised(overrides: KeybindingOverrides, command: KeybindingCommand): boolean {
  return overrides[command] !== undefined;
}

/** What a row shows for its condition. */
export function whenSummary(when: string): string {
  return when.trim() === "" ? "Always" : when;
}

/**
 * True when every word of `query` is found in the binding's title, group, key (as the board writes it and as it is
 * shown), condition or command name. An empty query matches all.
 */
export function matchesKeybindingQuery(binding: ResolvedKeybinding, query: string, shortcutLabel: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const def = DEFAULT_KEYBINDINGS[binding.command];
  const haystack = [def.title, def.group, binding.command, binding.key, shortcutLabel, whenSummary(binding.when)]
    .join("\n")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface KeybindingSection extends KeybindingGroup {
  bindings: ResolvedKeybinding[];
}

/** The bindings matching `query`, under their registry group in registry order. A group with none left is dropped. */
export function keybindingSections(
  bindings: readonly ResolvedKeybinding[],
  query: string,
  shortcutLabel: (shortcut: string) => string,
): KeybindingSection[] {
  return keybindingGroups()
    .map((group) => ({
      ...group,
      bindings: bindings.filter(
        (binding) =>
          DEFAULT_KEYBINDINGS[binding.command].group === group.label &&
          matchesKeybindingQuery(binding, query, shortcutLabel(binding.key)),
      ),
    }))
    .filter((section) => section.bindings.length > 0);
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
  // Space types a character too, though its name is longer.
  if (mod || alt || (key.length !== 1 && key !== "space") || !EDITABLE_FOCUS.ok) return false;
  return whenOverlaps(binding.condition, EDITABLE_FOCUS.node);
}

/** The note under a command that would trigger while typing. */
export const TYPING_WARNING = "Typing this key in a text field runs it. Add !editableFocus to When to stop that.";
