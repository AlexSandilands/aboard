import { describe, expect, it } from "vitest";
import { type AgentModel, modelEffortLevels } from "./agentModels.ts";
import { CLI_EFFORTS } from "./modelTiers.ts";

const model = (effortLevels: AgentModel["effortLevels"]): AgentModel => ({
  value: "opus",
  label: "Opus",
  description: null,
  effortLevels,
});

describe("model effort levels", () => {
  it("offers a model's scanned levels, else the harness's own", () => {
    expect(modelEffortLevels("claude-code", model(["low", "high"]))).toEqual(["low", "high"]);
    expect(modelEffortLevels("claude-code", model(null))).toBe(CLI_EFFORTS["claude-code"]);
    expect(modelEffortLevels("claude-code", model([]))).toBe(CLI_EFFORTS["claude-code"]);
    expect(modelEffortLevels("copilot-cli", undefined)).toBe(CLI_EFFORTS["copilot-cli"]);
  });
});
