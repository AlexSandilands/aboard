import type { AgentModel } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { commitModel, findSuggestion, modelMatches, suggestedModels } from "./cliModelPicker.logic";

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

describe("modelMatches", () => {
  it("matches the value, name or description, ignoring case", () => {
    expect(modelMatches(scanned[0]!, "OPU", "")).toBe(true);
    expect(modelMatches(scanned[0]!, "everyday", "")).toBe(true);
    expect(modelMatches(scanned[1]!, "sonn", "")).toBe(true);
    expect(modelMatches(scanned[2]!, "sonn", "")).toBe(false);
  });

  it("matches everything for a blank query, and for the saved model as the field shows it", () => {
    expect(scanned.every((m) => modelMatches(m, "", "opus"))).toBe(true);
    expect(scanned.every((m) => modelMatches(m, "  ", "opus"))).toBe(true);
    expect(scanned.every((m) => modelMatches(m, "opus", "opus"))).toBe(true);
    expect(modelMatches(scanned[2]!, "opus", "")).toBe(false);
  });
});

describe("commitModel", () => {
  it("does nothing when the text is the saved model, ignoring spaces", () => {
    expect(commitModel("opus", "opus")).toEqual({ kind: "none" });
    expect(commitModel(" opus ", "opus")).toEqual({ kind: "none" });
    expect(commitModel("", "")).toEqual({ kind: "none" });
  });

  it("saves a typed model trimmed, and clears on blank", () => {
    expect(commitModel(" sonnet[1m] ", "opus")).toEqual({ kind: "save", value: "sonnet[1m]" });
    expect(commitModel("claude-opus-5-5", "")).toEqual({ kind: "save", value: "claude-opus-5-5" });
    expect(commitModel("  ", "opus")).toEqual({ kind: "save", value: null });
  });

  it("refuses text that couldn't go on a command line", () => {
    expect(commitModel("opus; calc", "")).toMatchObject({ kind: "invalid" });
    expect(commitModel("a b", "opus")).toMatchObject({ kind: "invalid" });
  });
});

describe("findSuggestion", () => {
  it("finds the scanned model for a saved value", () => {
    expect(findSuggestion(scanned, " haiku ")).toBe(scanned[2]);
    expect(findSuggestion(scanned, "gpt")).toBeUndefined();
  });
});
