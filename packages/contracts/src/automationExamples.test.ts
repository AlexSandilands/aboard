import { describe, expect, it } from "vitest";
import { AutomationBundle } from "./automationBundle.ts";
import { AUTOMATION_RECIPES } from "./automationExamples.ts";

describe("AUTOMATION_RECIPES", () => {
  it("are valid bundles with distinct ids", () => {
    expect(new Set(AUTOMATION_RECIPES.map((r) => r.id)).size).toBe(AUTOMATION_RECIPES.length);
    for (const recipe of AUTOMATION_RECIPES) {
      expect(AutomationBundle.safeParse(recipe.bundle).success).toBe(true);
      expect(recipe.bundle.name).toBe(recipe.title);
    }
  });
});
