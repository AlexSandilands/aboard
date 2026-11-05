import { INHERIT, ModelChoice, T3_RUNTIME_MODES, T3RuntimeMode, type AutopilotField } from "@repo/contracts";
import { z } from "zod";

// The config fields every agent automation shares: which runner, and its limits. An automation spreads
// RUNNER_OPTION_SHAPE into its schema, RUNNER_FIELDS into its fields and RUNNER_DEFAULTS into its defaults; the
// runner reads them back from the config with readRunnerOptions.

/** Auto: a T3 Code thread when T3 is connected, else headless. */
export const RunnerChoice = z.enum(["auto", "t3", "headless"]);
export type RunnerChoice = z.infer<typeof RunnerChoice>;

export const RUNNER_OPTION_SHAPE = {
  runner: RunnerChoice,
  /** Headless: `--max-budget-usd`, for Claude Code only (Codex and Copilot CLI have no cap). */
  budgetUsd: z.number().positive().max(100),
  /** Headless: the run is stopped after this long. */
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /**
   * The model the run starts on (resolveOperationChoice): inherit takes the board's setting for the operation, then
   * the task's own; or a tier, a custom model, or a model typed for one provider. Before 041_operation_models a typed
   * `model` sat beside it; that migration folded it in.
   */
  modelChoice: ModelChoice,
  /** T3: the most access a thread gets; "default" is T3's own default, which is also the ceiling. */
  t3Access: z.union([z.literal("default"), T3RuntimeMode]),
};

export const RunnerOptions = z.object(RUNNER_OPTION_SHAPE);
export type RunnerOptions = z.infer<typeof RunnerOptions>;

export const RUNNER_DEFAULTS: RunnerOptions = {
  runner: "auto",
  budgetUsd: 5,
  timeoutMinutes: 60,
  modelChoice: INHERIT,
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
      { value: "headless", label: "Headless only (a CLI in a worktree)" },
    ],
  },
  {
    key: "modelChoice",
    label: "Model",
    kind: "model",
    help: "Inherit: the board's model for this kind of run, else the task's (a custom model one of its labels picks, else its suggested tier). Set in Settings → Model tiers.",
  },
  {
    key: "budgetUsd",
    label: "Headless budget",
    kind: "number",
    min: 0.5,
    max: 100,
    step: 0.5,
    unit: "USD",
    help: "Claude Code only. Codex and Copilot CLI runs have no spending cap and report no cost: only the timeout stops them.",
  },
  { key: "timeoutMinutes", label: "Headless timeout", kind: "number", min: 1, max: 1440, unit: "minutes" },
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
