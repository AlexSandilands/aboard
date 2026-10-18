import { describe, expect, it } from "vitest";
import { HeadlessModel, parseHeadlessModel, resolveHeadlessModel, sameHeadlessModel } from "./headlessModel.ts";
import { EMPTY_MODEL_TIERS } from "./modelTiers.ts";

const tiers = {
  ...EMPTY_MODEL_TIERS,
  light: { description: null, t3: null, cli: { "claude-code": "haiku", "copilot-cli": "gpt-5-mini" } },
  standard: { description: null, t3: null, cli: { "copilot-cli": "gpt-5" } },
};

describe("headless model", () => {
  it("parses a bare string as the typed model it was saved as before tiers", () => {
    expect(HeadlessModel.parse("haiku")).toEqual({ model: "haiku" });
    expect(HeadlessModel.parse("  claude-opus-5-5[1m] ")).toEqual({ model: "claude-opus-5-5[1m]" });
  });

  it("parses a tier or a typed model", () => {
    expect(HeadlessModel.parse({ tier: "deep" })).toEqual({ tier: "deep" });
    expect(HeadlessModel.parse({ model: "sonnet" })).toEqual({ model: "sonnet" });
  });

  it("refuses anything else, so it can't reach a command line", () => {
    for (const bad of ["", "  ", "a b", "x; y", { tier: "huge" }, { model: "" }, {}, null, 4]) {
      expect(parseHeadlessModel(bad)).toBeNull();
    }
  });

  it("resolves a tier to its Claude Code model, whatever the other harnesses run", () => {
    expect(resolveHeadlessModel(tiers, { tier: "light" })).toBe("haiku");
  });

  it("resolves to the CLI's default (null) when the tier has no Claude Code model, or nothing is chosen", () => {
    expect(resolveHeadlessModel(tiers, { tier: "standard" })).toBeNull();
    expect(resolveHeadlessModel(tiers, { tier: "deep" })).toBeNull();
    expect(resolveHeadlessModel(tiers, null)).toBeNull();
  });

  it("passes a typed model through as it is", () => {
    expect(resolveHeadlessModel(tiers, { model: "opus" })).toBe("opus");
  });

  it("compares choices", () => {
    expect(sameHeadlessModel({ tier: "light" }, { tier: "light" })).toBe(true);
    expect(sameHeadlessModel({ tier: "light" }, { model: "light" })).toBe(false);
    expect(sameHeadlessModel({ model: "a" }, { model: "a" })).toBe(true);
    expect(sameHeadlessModel({ model: "a" }, null)).toBe(false);
    expect(sameHeadlessModel(null, null)).toBe(true);
  });
});
