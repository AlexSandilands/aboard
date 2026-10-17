import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  KeybindingCommand,
  KeybindingOverrides,
  evaluateWhen,
  isValidShortcut,
  keybindingConflicts,
  parseWhen,
  resolveKeybindings,
  sanitizeKeybindingOverrides,
  whenOverlaps,
  type KeybindingContext,
  type WhenNode,
} from "./keybindings.ts";

const idle: KeybindingContext = {
  editableFocus: false,
  popupFocus: false,
  overlayOpen: false,
  paletteOpen: false,
  dialogOpen: false,
  settingsOpen: false,
  panelOpen: false,
  canGoBack: false,
};

const parse = (expression: string): WhenNode => {
  const parsed = parseWhen(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.node;
};
const holds = (expression: string, context: Partial<KeybindingContext> = {}) =>
  evaluateWhen(parse(expression), { ...idle, ...context });

describe("parseWhen", () => {
  it("treats an empty expression as always", () => {
    expect(holds("")).toBe(true);
    expect(holds("   ")).toBe(true);
  });

  it("reads keys, !, && and || with ! tightest and || loosest", () => {
    expect(holds("editableFocus")).toBe(false);
    expect(holds("!editableFocus")).toBe(true);
    expect(holds("!!editableFocus", { editableFocus: true })).toBe(true);
    expect(holds("panelOpen && !editableFocus", { panelOpen: true })).toBe(true);
    expect(holds("panelOpen && !editableFocus", { panelOpen: true, editableFocus: true })).toBe(false);
    // a || b && c is a || (b && c)
    expect(holds("settingsOpen || panelOpen && popupFocus", { settingsOpen: true })).toBe(true);
    expect(holds("settingsOpen || panelOpen && popupFocus", { panelOpen: true })).toBe(false);
    expect(holds("(settingsOpen || panelOpen) && popupFocus", { settingsOpen: true })).toBe(false);
    expect(holds("(settingsOpen || panelOpen) && popupFocus", { panelOpen: true, popupFocus: true })).toBe(true);
  });

  it("explains what is wrong", () => {
    expect(parseWhen("nope")).toEqual({ ok: false, error: 'Unknown condition "nope"' });
    expect(parseWhen("panelOpen &&")).toEqual({ ok: false, error: "The expression ends too early" });
    expect(parseWhen("(panelOpen")).toEqual({ ok: false, error: "A ( is never closed" });
    expect(parseWhen("panelOpen panelOpen")).toEqual({ ok: false, error: 'Unexpected "panelOpen"' });
    expect(parseWhen("panelOpen & popupFocus")).toEqual({ ok: false, error: 'Unexpected "&"' });
    expect(parseWhen("panelOpen)")).toEqual({ ok: false, error: 'Unexpected ")"' });
  });
});

describe("whenOverlaps", () => {
  it("is true when one context satisfies both", () => {
    expect(whenOverlaps(parse(""), parse("panelOpen"))).toBe(true);
    expect(whenOverlaps(parse("panelOpen"), parse("!editableFocus"))).toBe(true);
  });

  it("is false when they exclude each other", () => {
    expect(whenOverlaps(parse("panelOpen"), parse("!panelOpen"))).toBe(false);
    expect(whenOverlaps(parse("editableFocus && panelOpen"), parse("!editableFocus"))).toBe(false);
  });
});

describe("isValidShortcut", () => {
  it("accepts modifiers then one key", () => {
    for (const ok of ["k", "mod+k", "mod+shift+,", "escape", "alt+f5", "mod+plus", "shift+?", "mod+space"]) {
      expect({ ok, valid: isValidShortcut(ok) }).toEqual({ ok, valid: true });
    }
  });

  it("rejects the rest", () => {
    for (const bad of ["", "mod+", "mod", "shift", "ctrl+k", "Mod+K", "k+mod", "mod++", "a b", "mod+k+j"]) {
      expect({ bad, valid: isValidShortcut(bad) }).toEqual({ bad, valid: false });
    }
  });
});

describe("resolveKeybindings", () => {
  it("lists every command with its default", () => {
    const resolved = resolveKeybindings();
    expect(resolved.map((b) => b.command)).toEqual(KeybindingCommand.options);
    for (const binding of resolved) {
      expect(binding.key).toBe(DEFAULT_KEYBINDINGS[binding.command].key);
      expect(binding.when).toBe(DEFAULT_KEYBINDINGS[binding.command].when);
    }
  });

  it("applies overrides to the commands they name only", () => {
    const resolved = resolveKeybindings({ "idea.new": { key: "c" }, "palette.open": { when: "!editableFocus" } });
    const by = Object.fromEntries(resolved.map((b) => [b.command, b]));
    expect(by["idea.new"]!.key).toBe("c");
    expect(by["idea.new"]!.when).toBe(DEFAULT_KEYBINDINGS["idea.new"].when);
    expect(by["palette.open"]!.key).toBe("mod+k");
    expect(by["palette.open"]!.when).toBe("!editableFocus");
    expect(by["back"]!.key).toBe("escape");
  });

  it("lets an empty when mean always", () => {
    const ideaNew = resolveKeybindings({ "idea.new": { when: "" } }).find((b) => b.command === "idea.new")!;
    expect(evaluateWhen(ideaNew.condition, { ...idle, editableFocus: true })).toBe(true);
  });

  it("falls back to the default when for one it can't read", () => {
    const ideaNew = resolveKeybindings({ "idea.new": { when: "gone" } }).find((b) => b.command === "idea.new")!;
    expect(ideaNew.when).toBe(DEFAULT_KEYBINDINGS["idea.new"].when);
  });

  it("leaves a command the user didn't change on the current default", () => {
    // Overrides only name what the user changed, so a default added or edited later reaches everyone else.
    const resolved = resolveKeybindings({ "settings.open": { key: "mod+;" } });
    expect(resolved.filter((b) => b.command !== "settings.open").map((b) => b.key)).toEqual(
      KeybindingCommand.options.filter((c) => c !== "settings.open").map((c) => DEFAULT_KEYBINDINGS[c].key),
    );
  });
});

describe("keybindingConflicts", () => {
  it("has none by default", () => {
    expect(keybindingConflicts(resolveKeybindings()).size).toBe(0);
  });

  it("flags a shared key whose conditions can both hold", () => {
    const conflicts = keybindingConflicts(resolveKeybindings({ "idea.new": { key: "mod+k" } }));
    expect(conflicts.get("idea.new")).toEqual(["palette.open"]);
    expect(conflicts.get("palette.open")).toEqual(["idea.new"]);
  });

  it("ignores a shared key whose conditions exclude each other", () => {
    const bindings = resolveKeybindings({
      "palette.open": { key: "n", when: "editableFocus" },
      "idea.new": { key: "N" },
    });
    expect(keybindingConflicts(bindings).size).toBe(0);
  });
});

describe("overrides schema", () => {
  it("lowercases and checks keys and when", () => {
    expect(KeybindingOverrides.parse({ back: { key: " Mod+K " } })).toEqual({ back: { key: "mod+k" } });
    expect(KeybindingOverrides.safeParse({ back: { key: "ctrl+k" } }).success).toBe(false);
    expect(KeybindingOverrides.safeParse({ back: { when: "nope" } }).success).toBe(false);
    expect(KeybindingOverrides.safeParse({ nope: { key: "k" } }).success).toBe(false);
    expect(KeybindingOverrides.parse({ back: { when: "" } })).toEqual({ back: { when: "" } });
  });
});

describe("sanitizeKeybindingOverrides", () => {
  it("keeps what is valid and drops the rest", () => {
    expect(
      sanitizeKeybindingOverrides({
        back: { key: "q" },
        "idea.new": { key: "ctrl+nonsense" },
        removed: { key: "x" },
        "palette.open": {},
      }),
    ).toEqual({ back: { key: "q" } });
    expect(sanitizeKeybindingOverrides(null)).toEqual({});
    expect(sanitizeKeybindingOverrides("x")).toEqual({});
  });
});
