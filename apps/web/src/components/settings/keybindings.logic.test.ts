import { describe, expect, it } from "vitest";
import { describeConflict, withOverride, withoutOverride } from "./keybindings.logic";

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
