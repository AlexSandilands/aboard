import { resolveKeybindings, type KeybindingContext } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  resolveCommand,
  runsImmediately,
  shortcutFromEvent,
  shortcutParts,
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
  paletteOpen: false,
  dialogOpen: false,
  settingsOpen: false,
  panelOpen: false,
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

  it("names the space and plus keys", () => {
    expect(matchesShortcut(key(" "), "space", false)).toBe(true);
    expect(matchesShortcut(key("+", { ctrlKey: true }), "mod+plus", false)).toBe(true);
  });
});

describe("resolveCommand", () => {
  it("opens the palette on mod+k whatever has focus or is open", () => {
    const event = key("k", { ctrlKey: true });
    const busy = { ...idle, editableFocus: true, popupFocus: true, overlayOpen: true, canGoBack: true };
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
    const bindings = resolveKeybindings({ back: { key: "n", when: "canGoBack" } });
    expect(resolveCommand(key("n"), idle, false, bindings)).toBe("idea.new");
    expect(resolveCommand(key("n"), { ...idle, canGoBack: true }, false, bindings)).toBe("back");
  });

  it("follows a user's key and when", () => {
    const bindings = resolveKeybindings({
      "palette.open": { when: "!editableFocus" },
      "idea.new": { key: "mod+j" },
    });
    const event = key("k", { ctrlKey: true });
    expect(resolveCommand(event, idle, false, bindings)).toBe("palette.open");
    expect(resolveCommand(event, { ...idle, editableFocus: true }, false, bindings)).toBeNull();
    expect(resolveCommand(key("n"), idle, false, bindings)).toBeNull();
    expect(resolveCommand(key("j", { ctrlKey: true }), idle, false, bindings)).toBe("idea.new");
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

describe("shortcutFromEvent", () => {
  it("spells the event as a shortcut", () => {
    expect(shortcutFromEvent(key("K", { ctrlKey: true }), false)).toBe("mod+k");
    expect(shortcutFromEvent(key("k", { metaKey: true }), true)).toBe("mod+k");
    expect(shortcutFromEvent(key("?", { shiftKey: true }), false)).toBe("shift+?");
    expect(shortcutFromEvent(key("Escape"), false)).toBe("escape");
    expect(shortcutFromEvent(key(" ", { altKey: true }), false)).toBe("alt+space");
    expect(shortcutFromEvent(key("+", { ctrlKey: true }), false)).toBe("mod+plus");
  });

  it("waits for a key besides the modifiers, and refuses the modifier mod never matches", () => {
    expect(shortcutFromEvent(key("Control", { ctrlKey: true }), false)).toBeNull();
    expect(shortcutFromEvent(key("Shift", { shiftKey: true }), false)).toBeNull();
    expect(shortcutFromEvent(key("k", { metaKey: true }), false)).toBeNull();
    expect(shortcutFromEvent(key("k", { ctrlKey: true }), true)).toBeNull();
  });

  it("round-trips through matchesShortcut", () => {
    const events = [key(",", { ctrlKey: true }), key("+", { ctrlKey: true }), key(" "), key("F5", { altKey: true })];
    for (const event of events) {
      expect(matchesShortcut(event, shortcutFromEvent(event, false)!, false)).toBe(true);
    }
  });
});

describe("shortcutParts", () => {
  it("splits a shortcut into the keys to press", () => {
    expect(shortcutParts("mod+k", false)).toEqual(["Ctrl", "K"]);
    expect(shortcutParts("mod+shift+,", true)).toEqual(["⇧", "⌘", ","]);
    expect(shortcutParts("escape", false)).toEqual(["Esc"]);
  });
});

describe("formatShortcut", () => {
  it("reads as Ctrl+K off macOS and ⌘K on it", () => {
    expect(formatShortcut("mod+k", false)).toBe("Ctrl+K");
    expect(formatShortcut("mod+k", true)).toBe("⌘K");
    expect(formatShortcut("mod+shift+,", false)).toBe("Ctrl+Shift+,");
    expect(formatShortcut("escape", false)).toBe("Esc");
    expect(formatShortcut("n", true)).toBe("N");
  });
});
