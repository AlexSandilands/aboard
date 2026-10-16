import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  matchesShortcut,
  parseShortcut,
  resolveCommand,
  runsImmediately,
  type KeybindingContext,
  type KeyEventLike,
} from "./keyboard";

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const idle: KeybindingContext = {
  editableFocus: false,
  popupFocus: false,
  overlayOpen: false,
  panelOpen: false,
  paletteOpen: false,
};

describe("parseShortcut", () => {
  it("reads modifiers and the key", () => {
    expect(parseShortcut("mod+k")).toEqual({ key: "k", mod: true, shift: false, alt: false });
    expect(parseShortcut("Mod+Shift+N")).toEqual({ key: "n", mod: true, shift: true, alt: false });
    expect(parseShortcut("escape")).toEqual({ key: "escape", mod: false, shift: false, alt: false });
  });
});

describe("matchesShortcut", () => {
  it("uses Ctrl for mod off macOS and Cmd on macOS", () => {
    expect(matchesShortcut(key("k", { ctrlKey: true }), "mod+k", false)).toBe(true);
    expect(matchesShortcut(key("k", { metaKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { metaKey: true }), "mod+k", true)).toBe(true);
    expect(matchesShortcut(key("k", { ctrlKey: true }), "mod+k", true)).toBe(false);
  });

  it("ignores the case of the key", () => {
    expect(matchesShortcut(key("K", { ctrlKey: true }), "mod+k", false)).toBe(true);
    expect(matchesShortcut(key("N"), "n", false)).toBe(true);
  });

  it("requires the modifiers to match exactly", () => {
    expect(matchesShortcut(key("k", { ctrlKey: true, shiftKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { ctrlKey: true, altKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k"), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("n", { ctrlKey: true }), "n", false)).toBe(false);
    expect(matchesShortcut(key("n", { altKey: true }), "n", false)).toBe(false);
    expect(matchesShortcut(key("Escape", { shiftKey: true }), "escape", false)).toBe(false);
  });
});

describe("resolveCommand", () => {
  it("opens the palette on mod+k whatever has focus or is open", () => {
    const event = key("k", { ctrlKey: true });
    const busy = { editableFocus: true, popupFocus: true, overlayOpen: true, panelOpen: true, paletteOpen: true };
    expect(resolveCommand(event, idle, false)).toBe("palette.open");
    expect(resolveCommand(event, busy, false)).toBe("palette.open");
  });

  it("starts a new task on n only when nothing claims the focus", () => {
    expect(resolveCommand(key("n"), idle, false)).toBe("idea.new");
    expect(resolveCommand(key("N"), idle, false)).toBe("idea.new");
    expect(resolveCommand(key("n"), { ...idle, editableFocus: true }, false)).toBeNull();
    expect(resolveCommand(key("n"), { ...idle, popupFocus: true }, false)).toBeNull();
    expect(resolveCommand(key("n"), { ...idle, overlayOpen: true }, false)).toBeNull();
    expect(resolveCommand(key("n", { shiftKey: true }), idle, false)).toBeNull();
  });

  it("closes the panel on Escape only when it is open and nothing claims the focus", () => {
    const open = { ...idle, panelOpen: true };
    expect(resolveCommand(key("Escape"), open, false)).toBe("panel.close");
    expect(resolveCommand(key("Escape"), idle, false)).toBeNull();
    expect(resolveCommand(key("Escape"), { ...open, editableFocus: true }, false)).toBeNull();
    expect(resolveCommand(key("Escape"), { ...open, popupFocus: true }, false)).toBeNull();
    expect(resolveCommand(key("Escape"), { ...open, overlayOpen: true }, false)).toBeNull();
  });

  it("lets the last matching binding win", () => {
    const bindings = [
      { key: "n", command: "idea.new" as const },
      { key: "n", command: "panel.close" as const, when: (c: KeybindingContext) => c.panelOpen },
    ];
    expect(resolveCommand(key("n"), idle, false, bindings)).toBe("idea.new");
    expect(resolveCommand(key("n"), { ...idle, panelOpen: true }, false, bindings)).toBe("panel.close");
  });

  it("has no binding for other keys", () => {
    expect(resolveCommand(key("x"), idle, false)).toBeNull();
    expect(DEFAULT_KEYBINDINGS.length).toBeGreaterThan(0);
  });
});

describe("runsImmediately", () => {
  it("only runs the palette shortcut before the rest of the dispatch", () => {
    expect(runsImmediately("palette.open")).toBe(true);
    expect(runsImmediately("idea.new")).toBe(false);
    expect(runsImmediately("panel.close")).toBe(false);
  });
});
