import { describe, expect, it } from "vitest";
import {
  claudeAgentAlias,
  HeadlessModel,
  parseHeadlessModel,
  resolveHeadlessEffort,
  resolveHeadlessModel,
  reviewerModelLine,
  sameHeadlessModel,
} from "./headlessModel.ts";
import { EMPTY_MODEL_TIERS, ModelTiers } from "./modelTiers.ts";

const tiers = ModelTiers.parse({
  ...EMPTY_MODEL_TIERS,
  light: {
    description: null,
    t3: null,
    cli: { "claude-code": "haiku", "copilot-cli": "gpt-5-mini" },
    cliEffort: { "claude-code": "low", "copilot-cli": "none" },
  },
  standard: { description: null, t3: null, cli: { "copilot-cli": "gpt-5" } },
});

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

  it("resolves a tier's Claude Code effort, and none for a typed model", () => {
    expect(resolveHeadlessEffort(tiers, { tier: "light" })).toBe("low");
    expect(resolveHeadlessEffort(tiers, { tier: "standard" })).toBeNull();
    expect(resolveHeadlessEffort(tiers, { model: "haiku" })).toBeNull();
    expect(resolveHeadlessEffort(tiers, null)).toBeNull();
  });

  it("compares choices", () => {
    expect(sameHeadlessModel({ tier: "light" }, { tier: "light" })).toBe(true);
    expect(sameHeadlessModel({ tier: "light" }, { model: "light" })).toBe(false);
    expect(sameHeadlessModel({ model: "a" }, { model: "a" })).toBe(true);
    expect(sameHeadlessModel({ model: "a" }, null)).toBe(false);
    expect(sameHeadlessModel(null, null)).toBe(true);
  });

  it("finds the Agent tool's alias in a Claude Code model id", () => {
    expect(claudeAgentAlias("claude-opus-5-5")).toBe("opus");
    expect(claudeAgentAlias("Sonnet[1m]")).toBe("sonnet");
    expect(claudeAgentAlias("haiku")).toBe("haiku");
    expect(claudeAgentAlias("claude-fable-5-1")).toBe("fable");
    expect(claudeAgentAlias("gpt-5")).toBeNull();
  });

  it("words the reviewer's model for each kind of choice", () => {
    const named = ModelTiers.parse({
      ...tiers,
      deep: { description: "Opus 5.5", t3: null, cli: { "claude-code": "claude-opus-5-5" } },
    });
    expect(reviewerModelLine(named, null)).toBeNull();
    expect(reviewerModelLine(named, { tier: "deep" })).toBe(
      'Run the reviewer on the deep tier (Opus 5.5): in Claude Code pass `model: "opus"` to the Agent tool; elsewhere pick that model if your harness lets you, else use your own.',
    );
    // A tier without a Claude Code model can't be named to the Agent tool.
    expect(reviewerModelLine(named, { tier: "standard" })).toBe(
      "Run the reviewer on the standard tier: pick that model if your harness lets you, else use your own.",
    );
    expect(reviewerModelLine(named, { model: "sonnet" })).toContain('`sonnet`: in Claude Code pass `model: "sonnet"`');
    // No alias matches: the id goes through as typed.
    expect(reviewerModelLine(named, { model: "my-model" })).toContain('pass `model: "my-model"`');
  });
});
