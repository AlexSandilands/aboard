import { T3_RUNTIME_MODES, T3RuntimeMode, type AutopilotField } from "@repo/contracts";
import { z } from "zod";

// The config fields every agent automation shares: which runner, and its limits. An automation spreads
// RUNNER_OPTION_SHAPE into its schema, RUNNER_FIELDS into its fields and RUNNER_DEFAULTS into its defaults; the
// runner reads them back from the config with readRunnerOptions.

/** Auto: a T3 Code thread when T3 is connected, else headless. */
export const RunnerChoice = z.enum(["auto", "t3", "headless"]);
export type RunnerChoice = z.infer<typeof RunnerChoice>;

export const RUNNER_OPTION_SHAPE = {
  runner: RunnerChoice,
  /** Headless: `--max-budget-usd`. */
  budgetUsd: z.number().positive().max(100),
  /** Headless: the run is stopped after this long. */
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** Headless: `--model`; blank takes the task's tier (when it maps to a Claude model), else the CLI's default. */
  model: z.string(),
  /** T3: the most access a thread gets; "default" is T3's own default, which is also the ceiling. */
  t3Access: z.union([z.literal("default"), T3RuntimeMode]),
};

export const RunnerOptions = z.object(RUNNER_OPTION_SHAPE);
export type RunnerOptions = z.infer<typeof RunnerOptions>;

export const RUNNER_DEFAULTS: RunnerOptions = {
  runner: "auto",
  budgetUsd: 5,
  timeoutMinutes: 60,
  model: "",
  t3Access: "default",
};

export const RUNNER_FIELDS: AutopilotField[] = [
  {
    key: "runner",
    label: "Runner",
    kind: "select",
    options: [
      { value: "auto", label: "Auto (T3 Code when connected, else headless)" },
      { value: "t3", label: "T3 Code only" },
      { value: "headless", label: "Headless only (claude -p in a worktree)" },
    ],
  },
  { key: "budgetUsd", label: "Headless budget", kind: "number", min: 0.5, max: 100, step: 0.5, unit: "USD" },
  { key: "timeoutMinutes", label: "Headless timeout", kind: "number", min: 1, max: 1440, unit: "minutes" },
  {
    key: "model",
    label: "Headless model",
    kind: "text",
    placeholder: "From the task's tier",
    help: "As claude --model takes it, e.g. sonnet. Blank uses the task's tier when it maps to a Claude model.",
  },
  {
    key: "t3Access",
    label: "T3 Code access",
    kind: "select",
    help: "Never more than T3 Code's own default.",
    options: [
      { value: "default", label: "T3 Code's default" },
      ...T3_RUNTIME_MODES.map((m) => ({ value: m.value, label: m.label })),
    ],
  },
];

/** The runner options in an automation's config; anything missing or invalid takes its default. */
export function readRunnerOptions(config: Record<string, unknown>): RunnerOptions {
  const out = { ...RUNNER_DEFAULTS };
  for (const key of Object.keys(RUNNER_OPTION_SHAPE) as (keyof RunnerOptions)[]) {
    const parsed = RUNNER_OPTION_SHAPE[key].safeParse(config[key]);
    if (parsed.success) Object.assign(out, { [key]: parsed.data });
  }
  return out;
}
