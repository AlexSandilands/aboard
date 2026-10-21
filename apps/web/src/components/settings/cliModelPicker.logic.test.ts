import type { AgentModel } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { filterModels, findSuggestion, suggestedModels, typedModel } from "./cliModelPicker.logic";

const model = (value: string, label: string | null = null, description: string | null = null): AgentModel => ({
  value,
  label,
  description,
  effortLevels: null,
});
const scanned = [
  model("opus", "Opus", "Opus 5.5 · Best for everyday tasks"),
  model("sonnet[1m]", "Sonnet"),
  model("haiku"),
];

describe("suggestedModels", () => {
  it("lists the scanned models, with the saved one added when the scan lacks it", () => {
    expect(suggestedModels(scanned, "opus")).toEqual(scanned);
    expect(suggestedModels(scanned, "")).toEqual(scanned);
    expect(suggestedModels(scanned, " claude-opus-5-5 ").at(-1)).toEqual(model("claude-opus-5-5"));
    expect(suggestedModels([], "gpt-5.4")).toEqual([model("gpt-5.4")]);
  });
});

describe("filterModels", () => {
  it("matches the value, name or description, ignoring case", () => {
    expect(filterModels(scanned, "OPU")).toEqual([scanned[0]]);
    expect(filterModels(scanned, "everyday")).toEqual([scanned[0]]);
    expect(filterModels(scanned, "sonn")).toEqual([scanned[1]]);
    expect(filterModels(scanned, "gpt")).toEqual([]);
  });

  it("lists everything for a blank search", () => {
    expect(filterModels(scanned, "")).toEqual(scanned);
    expect(filterModels(scanned, "  ")).toEqual(scanned);
  });
});

describe("typedModel", () => {
  it("offers a typed model the list doesn't have, trimmed", () => {
    expect(typedModel(" sonnet[1m]x ", scanned)).toEqual({ kind: "use", value: "sonnet[1m]x" });
    expect(typedModel("claude-opus-5-5", [])).toEqual({ kind: "use", value: "claude-opus-5-5" });
  });

  it("offers nothing for a blank search or a listed model", () => {
    expect(typedModel("  ", scanned)).toBeNull();
    expect(typedModel(" haiku ", scanned)).toBeNull();
  });

  it("refuses text that couldn't go on a command line", () => {
    expect(typedModel("opus; calc", scanned)).toMatchObject({ kind: "invalid" });
    expect(typedModel("a b", scanned)).toMatchObject({ kind: "invalid" });
  });
});

describe("findSuggestion", () => {
  it("finds the scanned model for a saved value", () => {
    expect(findSuggestion(scanned, " haiku ")).toBe(scanned[2]);
    expect(findSuggestion(scanned, "gpt")).toBeUndefined();
  });
});
