import { describe, expect, it } from "vitest";
import {
  matchesShortcut,
  parseShortcut,
  resolveCommand,
  runsImmediately,
  type KeybindingContext,
  type KeyEventLike,
} from "./keyboard.logic";

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
  canGoBack: false,
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
    const busy = { editableFocus: true, popupFocus: true, overlayOpen: true, canGoBack: true };
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

  it("opens Settings on mod+, unless a dialog or the palette is open", () => {
    const event = key(",", { ctrlKey: true });
    expect(resolveCommand(event, idle, false)).toBe("settings.open");
    expect(resolveCommand(event, { ...idle, editableFocus: true }, false)).toBe("settings.open");
    expect(resolveCommand(event, { ...idle, overlayOpen: true }, false)).toBeNull();
    expect(resolveCommand(key(","), idle, false)).toBeNull();
  });

  it("goes back on Escape only when there is somewhere to go and nothing claims the focus", () => {
    const open = { ...idle, canGoBack: true };
    expect(resolveCommand(key("Escape"), open, false)).toBe("back");
    expect(resolveCommand(key("Escape"), idle, false)).toBeNull();
    expect(resolveCommand(key("Escape"), { ...open, editableFocus: true }, false)).toBeNull();
    expect(resolveCommand(key("Escape"), { ...open, popupFocus: true }, false)).toBeNull();
    expect(resolveCommand(key("Escape"), { ...open, overlayOpen: true }, false)).toBeNull();
  });

  it("lets the last matching binding win", () => {
    const bindings = [
      { key: "n", command: "idea.new" as const },
      { key: "n", command: "back" as const, when: (c: KeybindingContext) => c.canGoBack },
    ];
    expect(resolveCommand(key("n"), idle, false, bindings)).toBe("idea.new");
    expect(resolveCommand(key("n"), { ...idle, canGoBack: true }, false, bindings)).toBe("back");
  });

  it("has no binding for other keys", () => {
    expect(resolveCommand(key("x"), idle, false)).toBeNull();
  });
});

describe("runsImmediately", () => {
  it("only runs the palette shortcut before the rest of the dispatch", () => {
    expect(runsImmediately("palette.open")).toBe(true);
    expect(runsImmediately("idea.new")).toBe(false);
    expect(runsImmediately("back")).toBe(false);
    expect(runsImmediately("settings.open")).toBe(false);
  });
});
