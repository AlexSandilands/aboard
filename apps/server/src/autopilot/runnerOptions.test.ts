import { AutopilotField, DEFAULT_AGENT_DEFAULTS } from "@repo/contracts";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  agentDefaultsFor,
  readRunnerOptions,
  RUNNER_DEFAULTS,
  RUNNER_FIELDS,
  RUNNER_OPTION_SHAPE,
  RunnerOptions,
} from "./runnerOptions.ts";

describe("runner options", () => {
  it("describe a valid field for each option, with defaults that parse", () => {
    expect(RUNNER_FIELDS.map((f) => f.key).sort()).toEqual(Object.keys(RUNNER_OPTION_SHAPE).sort());
    for (const field of RUNNER_FIELDS) expect(AutopilotField.safeParse(field).success).toBe(true);
    expect(RunnerOptions.parse(RUNNER_DEFAULTS)).toEqual(RUNNER_DEFAULTS);
  });

  it("read from an automation's config, with defaults for what is missing or invalid", () => {
    expect(readRunnerOptions({})).toEqual(RUNNER_DEFAULTS);
    expect(
      readRunnerOptions({ runner: "headless", budgetUsd: -1, timeoutMinutes: 15, t3Access: "root", other: 1 }),
    ).toEqual({ ...RUNNER_DEFAULTS, runner: "headless", timeoutMinutes: 15 });
  });

  it("fall back to the board's agent defaults, then the built-in ones", () => {
    const board = { runner: "t3" as const, budgetUsd: 2, timeoutMinutes: 15, t3Access: "auto" as const };
    expect(readRunnerOptions({}, board)).toEqual({ ...board, modelChoice: RUNNER_DEFAULTS.modelChoice });
    expect(readRunnerOptions({ budgetUsd: 9, timeoutMinutes: 0 }, board)).toMatchObject({
      budgetUsd: 9,
      timeoutMinutes: 15,
    });
  });
});

describe("agentDefaultsFor", () => {
  const board = { ...DEFAULT_AGENT_DEFAULTS, runner: "t3" as const, budgetUsd: 8 };

  it("gives an automation the board's value for each runner option it has", () => {
    const automation = { schema: RunnerOptions, defaults: RUNNER_DEFAULTS };
    expect(agentDefaultsFor(automation, board)).toEqual(board);
  });

  it("leaves out options the automation doesn't have or doesn't accept", () => {
    // Orchestrate: headless only, no runner or T3 access.
    const orchestrate = {
      schema: z.object({
        budgetUsd: RUNNER_OPTION_SHAPE.budgetUsd,
        timeoutMinutes: RUNNER_OPTION_SHAPE.timeoutMinutes,
      }),
      defaults: { budgetUsd: 5, timeoutMinutes: 60 },
    };
    expect(agentDefaultsFor(orchestrate, board)).toEqual({ budgetUsd: 8, timeoutMinutes: 60 });
    // Review PRs: auto or headless, so a board default of T3 Code leaves its own.
    const review = {
      schema: RunnerOptions.extend({ runner: z.enum(["auto", "headless"]) }),
      defaults: { ...RUNNER_DEFAULTS, runner: "headless" },
    };
    expect(agentDefaultsFor(review, board)).not.toHaveProperty("runner");
    expect(agentDefaultsFor(review, { ...board, runner: "auto" })).toMatchObject({ runner: "auto" });
  });
});
