import { fieldTier } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AUTOMATIONS } from "./index.ts";

const essentials = (key: string) =>
  AUTOMATIONS.find((a) => a.key === key)!
    .fields.filter((f) => fieldTier(f) === "essential")
    .map((f) => f.key);

describe("the built-in catalogue", () => {
  it("lists every built-in under a group of its own, never the user's", () => {
    expect(AUTOMATIONS.filter((a) => !a.group || a.group === "yours").map((a) => a.key)).toEqual([]);
  });

  it("shows only each automation's essentials up front", () => {
    expect(essentials("start_planned")).toEqual(["skill"]);
    expect(essentials("fix_prs")).toEqual([
      "onChecks",
      "onConflicts",
      "onChangesRequested",
      "onComments",
      "onAutopilotReview",
      "fixThreshold",
      "attempts",
      "commentAttempts",
    ]);
    expect(essentials("review_prs")).toEqual(["skill", "rounds"]);
    expect(essentials("orchestrate")).toEqual(["everyMinutes", "instructions"]);
    expect(essentials("auto_archive")).toEqual(["days"]);
    expect(essentials("digest")).toEqual(["mode", "time", "weekdaysOnly"]);
  });

  it("keeps the agent's runner, model, budget, timeout and T3 access under Advanced", () => {
    const runnerKeys = new Set(["runner", "modelChoice", "budgetUsd", "timeoutMinutes", "t3Access"]);
    const upFront = AUTOMATIONS.flatMap((a) =>
      a.fields.filter((f) => runnerKeys.has(f.key) && fieldTier(f) === "essential").map((f) => `${a.key}.${f.key}`),
    );
    expect(upFront).toEqual([]);
  });
});
