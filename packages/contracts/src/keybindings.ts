import { z } from "zod";

// User-configurable shortcuts (docs/features/board-layout.md#keyboard-shortcuts). Shaped like t3code's keybindings:
// a command, a key and a `when` expression over a few context flags; the last matching binding wins.

export const KeybindingCommand = z.enum(["palette.open", "idea.new", "settings.open", "back", "task.reveal"]);
export type KeybindingCommand = z.infer<typeof KeybindingCommand>;

/** What a `when` expression can name. The web app builds one per key event from its stores and the event target. */
export const KEYBINDING_CONTEXT_KEYS = [
  /** Focus is in a text field. */
  "editableFocus",
  /** Focus is inside a menu, listbox or dialog, which handle their own keys. */
  "popupFocus",
  /** The palette or a dialog is open. */
  "overlayOpen",
  "paletteOpen",
  "dialogOpen",
  /** The Settings page is showing. */
  "settingsOpen",
  /** The task detail panel is open. */
  "panelOpen",
  /** Escape has somewhere to go back to: the task panel is open, or Settings is showing. */
  "canGoBack",
] as const;
export type KeybindingContextKey = (typeof KEYBINDING_CONTEXT_KEYS)[number];
export type KeybindingContext = Record<KeybindingContextKey, boolean>;

const CONTEXT_KEY_SET: ReadonlySet<string> = new Set(KEYBINDING_CONTEXT_KEYS);

export interface KeybindingDef {
  title: string;
  /** The heading it is listed under in Settings. */
  group: string;
  /** `mod+k`, `shift+n`, `escape`: `mod` is Cmd on macOS and Ctrl elsewhere. */
  key: string;
  /** An expression over the context keys; empty means always. */
  when: string;
  /** Runs inside the keydown (and prevents its default) instead of waiting to see whether something nearer claimed it. */
  immediate?: boolean;
}

const NO_FOCUS_CLAIM = "!overlayOpen && !editableFocus && !popupFocus";

export const DEFAULT_KEYBINDINGS: Record<KeybindingCommand, KeybindingDef> = {
  "palette.open": { title: "Open the command palette", group: "General", key: "mod+k", when: "", immediate: true },
  "idea.new": { title: "New task", group: "General", key: "n", when: NO_FOCUS_CLAIM },
  "settings.open": { title: "Open Settings", group: "General", key: "mod+,", when: "!overlayOpen" },
  back: {
    title: "Back: close the panel or leave Settings",
    group: "Navigation",
    key: "escape",
    when: `canGoBack && ${NO_FOCUS_CLAIM}`,
  },
  "task.reveal": {
    title: "Jump to the task on the board",
    group: "Navigation",
    key: "j",
    when: `panelOpen && !settingsOpen && ${NO_FOCUS_CLAIM}`,
  },
};

// ---- when expressions: `!`, `&&`, `||`, parentheses and context keys, with `!` binding tightest and `||` loosest.

export type WhenNode =
  | { type: "always" }
  | { type: "key"; name: KeybindingContextKey }
  | { type: "not"; operand: WhenNode }
  | { type: "and" | "or"; left: WhenNode; right: WhenNode };

export type WhenParse = { ok: true; node: WhenNode } | { ok: false; error: string };

class WhenError extends Error {}

const WHEN_TOKEN = /\s*(&&|\|\||!|\(|\)|[A-Za-z_]\w*|\S)/y;

/** Parses a `when` expression. An empty one is always true. */
export function parseWhen(expression: string): WhenParse {
  const tokens: string[] = [];
  WHEN_TOKEN.lastIndex = 0;
  for (let match = WHEN_TOKEN.exec(expression); match; match = WHEN_TOKEN.exec(expression)) tokens.push(match[1]!);
  if (tokens.length === 0) return { ok: true, node: { type: "always" } };

  let pos = 0;
  const fail = (message: string): never => {
    throw new WhenError(message);
  };
  const parseOr = (): WhenNode => {
    let left = parseAnd();
    while (tokens[pos] === "||") {
      pos++;
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): WhenNode => {
    let left = parseUnary();
    while (tokens[pos] === "&&") {
      pos++;
      left = { type: "and", left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): WhenNode => {
    const token = tokens[pos++];
    if (token === undefined) return fail("The expression ends too early");
    if (token === "!") return { type: "not", operand: parseUnary() };
    if (token === "(") {
      const inner = parseOr();
      if (tokens[pos++] !== ")") fail("A ( is never closed");
      return inner;
    }
    if (CONTEXT_KEY_SET.has(token)) return { type: "key", name: token as KeybindingContextKey };
    return fail(/^\w+$/.test(token) ? `Unknown condition "${token}"` : `Unexpected "${token}"`);
  };

  try {
    const node = parseOr();
    if (pos < tokens.length) fail(`Unexpected "${tokens[pos]}"`);
    return { ok: true, node };
  } catch (error) {
    if (error instanceof WhenError) return { ok: false, error: error.message };
    throw error;
  }
}

export function evaluateWhen(node: WhenNode, context: KeybindingContext): boolean {
  switch (node.type) {
    case "always":
      return true;
    case "key":
      return context[node.name];
    case "not":
      return !evaluateWhen(node.operand, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

function whenKeys(node: WhenNode, into: Set<KeybindingContextKey>): Set<KeybindingContextKey> {
  switch (node.type) {
    case "always":
      break;
    case "key":
      into.add(node.name);
      break;
    case "not":
      whenKeys(node.operand, into);
      break;
    default:
      whenKeys(node.left, into);
      whenKeys(node.right, into);
  }
  return into;
}

/** True when some context satisfies both conditions, so a key bound under both would be ambiguous. */
export function whenOverlaps(a: WhenNode, b: WhenNode): boolean {
  const keys = [...whenKeys(b, whenKeys(a, new Set()))];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const context = Object.fromEntries(KEYBINDING_CONTEXT_KEYS.map((key) => [key, false])) as KeybindingContext;
    keys.forEach((key, i) => {
      context[key] = (mask & (1 << i)) !== 0;
    });
    if (evaluateWhen(a, context) && evaluateWhen(b, context)) return true;
  }
  return false;
}

// ---- shortcuts and what the user overrides

const SHORTCUT = /^(?:(?:mod|shift|alt)\+)*(?!(?:mod|shift|alt)$)(?:[^\s+]|[a-z0-9]{2,})$/;

/** True for `mod+k`, `shift+/` or `escape`: lowercase modifiers (mod, shift, alt), then one key. A plus key is `plus`. */
export const isValidShortcut = (shortcut: string): boolean => SHORTCUT.test(shortcut);

/** The shortcut with its modifiers once each and in the order mod, shift, alt, so two spellings of one key compare equal. */
function normalizeShortcut(shortcut: string): string {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return [...(["mod", "shift", "alt"] as const).filter((modifier) => parts.includes(modifier)), key].join("+");
}

/** True when the shortcut uses Ctrl/Cmd or Alt, the keys browsers keep their own commands (print, find, save) on. */
const usesCommandModifier = (shortcut: string): boolean => /^(?:.*\+)?(?:mod|alt)\+/.test(shortcut);

export const KeybindingOverride = z.object({
  /** Replaces the default key; left out keeps it. */
  key: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isValidShortcut, { message: "Not a shortcut like mod+k or escape" })
    .transform(normalizeShortcut)
    .optional(),
  /** Replaces the default `when`; an empty string means always, left out keeps the default. */
  when: z
    .string()
    .trim()
    .max(200)
    .superRefine((expression, ctx) => {
      const parsed = parseWhen(expression);
      if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
    })
    .optional(),
});
export type KeybindingOverride = z.infer<typeof KeybindingOverride>;

/** Only the commands the user changed, so a default added later reaches everyone who didn't. */
export const KeybindingOverrides = z.partialRecord(KeybindingCommand, KeybindingOverride);
export type KeybindingOverrides = z.infer<typeof KeybindingOverrides>;

export interface ResolvedKeybinding {
  command: KeybindingCommand;
  key: string;
  /** The expression as written. */
  when: string;
  condition: WhenNode;
  /** Runs inside the keydown and prevents its default, instead of waiting to see whether something nearer claimed it. */
  immediate: boolean;
}

/** Every command's binding, in the order they are listed (and, for a shared key, the later one winning). */
export function resolveKeybindings(overrides: KeybindingOverrides = {}): ResolvedKeybinding[] {
  return KeybindingCommand.options.map((command) => {
    const def = DEFAULT_KEYBINDINGS[command];
    const override = overrides[command];
    const key = override?.key ?? def.key;
    let when = override?.when ?? def.when;
    let parsed = parseWhen(when);
    if (!parsed.ok) {
      // Stored by an older build that knew other context keys: the default is the safe reading.
      when = def.when;
      parsed = parseWhen(when);
    }
    return {
      command,
      key,
      when,
      condition: parsed.ok ? parsed.node : { type: "always" },
      // A key the user picked with Ctrl/Cmd or Alt is one the browser may use too (Ctrl+P prints): only running inside
      // the keydown can stop that. The defaults keep waiting for a nearer claim, as they always did.
      immediate: (def.immediate ?? false) || (override?.key !== undefined && usesCommandModifier(key)),
    };
  });
}

/** For each command, the others bound to the same key under a condition that can hold at the same time. */
export function keybindingConflicts(
  bindings: readonly ResolvedKeybinding[],
): Map<KeybindingCommand, KeybindingCommand[]> {
  const conflicts = new Map<KeybindingCommand, KeybindingCommand[]>();
  for (const a of bindings) {
    for (const b of bindings) {
      if (a === b || normalizeShortcut(a.key) !== normalizeShortcut(b.key) || !whenOverlaps(a.condition, b.condition))
        continue;
      conflicts.set(a.command, [...(conflicts.get(a.command) ?? []), b.command]);
    }
  }
  return conflicts;
}

/** Drops what a stored value gets wrong (a command since removed, a malformed key) and keeps the rest. */
export function sanitizeKeybindingOverrides(stored: unknown): KeybindingOverrides {
  if (typeof stored !== "object" || stored === null) return {};
  const clean: KeybindingOverrides = {};
  for (const command of KeybindingCommand.options) {
    const parsed = KeybindingOverride.safeParse((stored as Record<string, unknown>)[command]);
    if (parsed.success && (parsed.data.key !== undefined || parsed.data.when !== undefined))
      clean[command] = parsed.data;
  }
  return clean;
}
