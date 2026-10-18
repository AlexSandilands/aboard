import { DEFAULT_KEYBINDINGS, KeybindingCommand, resolveKeybindings, type KeybindingOverrides } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { formatShortcut } from "~/components/layout/keyboard.logic";
import {
  describeConflict,
  isCustomised,
  keybindingGroups,
  keybindingSectionId,
  keybindingSections,
  matchesKeybindingQuery,
  triggersWhileTyping,
  whenSummary,
  withOverride,
  withoutOverride,
} from "./keybindings.logic";

describe("withOverride", () => {
  it("stores a changed key", () => {
    expect(withOverride({}, "idea.new", { key: "C" })).toEqual({ "idea.new": { key: "c" } });
  });

  it("keeps the other fields and commands", () => {
    const before = { "idea.new": { key: "c" }, back: { key: "q" } };
    expect(withOverride(before, "idea.new", { when: "panelOpen" })).toEqual({
      back: { key: "q" },
      "idea.new": { key: "c", when: "panelOpen" },
    });
  });

  it("drops a value equal to the default, and the command once nothing is left", () => {
    const before = { "idea.new": { key: "c", when: "panelOpen" } };
    expect(withOverride(before, "idea.new", { key: "n" })).toEqual({ "idea.new": { when: "panelOpen" } });
    expect(withOverride({ "idea.new": { key: "c" } }, "idea.new", { key: "n" })).toEqual({});
    expect(withOverride({}, "palette.open", { key: "mod+k", when: "" })).toEqual({});
  });

  it("keeps an empty when, which differs from a default that has a condition", () => {
    expect(withOverride({}, "idea.new", { when: " " })).toEqual({ "idea.new": { when: "" } });
  });
});

describe("withoutOverride", () => {
  it("resets one command", () => {
    expect(withoutOverride({ back: { key: "q" }, "idea.new": { key: "c" } }, "back")).toEqual({
      "idea.new": { key: "c" },
    });
  });
});

describe("describeConflict", () => {
  it("names the other commands", () => {
    expect(describeConflict(["idea.new"])).toBe("Same key as New task: where both apply, the one listed later wins.");
    expect(describeConflict(["idea.new", "settings.open"])).toContain("New task and Open Settings");
    expect(describeConflict(["palette.open", "idea.new", "settings.open"])).toContain(
      "Open the command palette, New task and Open Settings",
    );
  });
});

describe("triggersWhileTyping", () => {
  const flagged = (overrides: KeybindingOverrides) =>
    resolveKeybindings(overrides)
      .filter(triggersWhileTyping)
      .map((b) => b.command);

  it("has nothing flagged by default", () => {
    expect(flagged({})).toEqual([]);
  });

  it("flags a bare character that nothing keeps out of text fields", () => {
    expect(flagged({ "palette.open": { key: "p" } })).toEqual(["palette.open"]);
    expect(flagged({ "idea.new": { when: "" } })).toEqual(["idea.new"]);
    expect(flagged({ "idea.new": { key: "shift+space", when: "" } })).toEqual(["idea.new"]);
  });

  it("lets a condition, a modifier or a non-typing key through", () => {
    expect(flagged({ "palette.open": { key: "p", when: "!editableFocus" } })).toEqual([]);
    expect(flagged({ "palette.open": { key: "mod+p" } })).toEqual([]);
    expect(flagged({ "palette.open": { key: "escape" } })).toEqual([]);
  });
});

describe("keybindingGroups", () => {
  it("has a group per registry heading, in registry order, with a section id each", () => {
    expect(keybindingGroups().map((group) => group.label)).toEqual(["General", "Navigation"]);
    expect(keybindingGroups().map((group) => group.sectionId)).toEqual([
      "keybindings.general",
      "keybindings.navigation",
    ]);
    expect(keybindingGroups().map((group) => group.slug)).toEqual(["general", "navigation"]);
  });

  it("turns any heading into an id segment", () => {
    expect(keybindingSectionId("Task panel & more")).toBe("keybindings.task-panel-more");
  });
});

describe("keybindingSections", () => {
  const label = (shortcut: string) => formatShortcut(shortcut, false);
  const sections = (query: string, overrides: KeybindingOverrides = {}) =>
    keybindingSections(resolveKeybindings(overrides), query, label).map((section) => [
      section.label,
      section.bindings.map((binding) => binding.command),
    ]);

  it("lists every command once, under its registry group", () => {
    const listed = keybindingSections(resolveKeybindings(), "", label).flatMap((section) =>
      section.bindings.map((binding) => binding.command),
    );
    expect([...listed].sort()).toEqual([...KeybindingCommand.options].sort());
    for (const section of keybindingSections(resolveKeybindings(), "", label)) {
      for (const binding of section.bindings) expect(DEFAULT_KEYBINDINGS[binding.command].group).toBe(section.label);
    }
  });

  it("filters by title, shown key and condition, and drops groups left empty", () => {
    expect(sections("palette")).toEqual([["General", ["palette.open"]]]);
    expect(sections("ctrl+k")).toEqual([["General", ["palette.open"]]]);
    expect(sections("canGoBack")).toEqual([["Navigation", ["back"]]]);
    expect(sections("navigation")).toEqual([["Navigation", ["back"]]]);
    expect(sections("nothing like this")).toEqual([]);
  });

  it("needs every word, in any order, and ignores case", () => {
    expect(sections("PALETTE command")).toEqual([["General", ["palette.open"]]]);
    expect(sections("settings palette")).toEqual([]);
  });

  it("matches a changed key or condition, and Always for an empty one", () => {
    expect(sections("shift+q", { back: { key: "shift+q" } })).toEqual([["Navigation", ["back"]]]);
    expect(sections("always")).toEqual([["General", ["palette.open"]]]);
    expect(sections("canGoBack", { "idea.new": { when: "canGoBack" } })).toEqual([
      ["General", ["idea.new"]],
      ["Navigation", ["back"]],
    ]);
  });
});

describe("matchesKeybindingQuery", () => {
  it("matches everything for a blank query", () => {
    const [binding] = resolveKeybindings();
    expect(matchesKeybindingQuery(binding!, "  ", "Ctrl+K")).toBe(true);
  });
});

describe("isCustomised", () => {
  it("is true only for a command with a stored override, which is never one equal to the default", () => {
    expect(isCustomised({}, "back")).toBe(false);
    expect(isCustomised(withOverride({}, "back", { key: "q" }), "back")).toBe(true);
    expect(isCustomised(withOverride({}, "back", { key: DEFAULT_KEYBINDINGS.back.key }), "back")).toBe(false);
    expect(
      isCustomised(withOverride({ back: { key: "q" } }, "back", { key: DEFAULT_KEYBINDINGS.back.key }), "back"),
    ).toBe(false);
  });
});

describe("whenSummary", () => {
  it("says Always for no condition, else the expression", () => {
    expect(whenSummary("")).toBe("Always");
    expect(whenSummary("  ")).toBe("Always");
    expect(whenSummary("!editableFocus && !overlayOpen")).toBe("!editableFocus && !overlayOpen");
  });
});

describe("editing a when-expression", () => {
  it("stores a changed condition, and drops it again once it equals the default", () => {
    const edited = withOverride({}, "palette.open", { when: " !overlayOpen " });
    expect(edited).toEqual({ "palette.open": { when: "!overlayOpen" } });
    expect(resolveKeybindings(edited).find((b) => b.command === "palette.open")?.when).toBe("!overlayOpen");
    expect(withOverride(edited, "palette.open", { when: DEFAULT_KEYBINDINGS["palette.open"].when })).toEqual({});
  });
});
