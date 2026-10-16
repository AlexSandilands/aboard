import { AutopilotField } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
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
});
