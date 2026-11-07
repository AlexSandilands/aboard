import {
  AGENT_DEFAULT_KEYS,
  AutopilotAgentDefaults,
  DEFAULT_AGENT_DEFAULTS,
  INHERIT,
  ModelChoice,
  RUNNER_CHOICES,
  T3_RUNTIME_MODES,
  type AutopilotField,
  type OperationId,
  type OperationNeed,
} from "@repo/contracts";
import { z } from "zod";
import type { Automation, AutomationConfig } from "./types.ts";

// The config fields every agent automation shares: which runner, and its limits. An automation spreads
// RUNNER_OPTION_SHAPE into its schema, RUNNER_FIELDS into its fields and RUNNER_DEFAULTS into its defaults; the
// runner reads them back from the config with readRunnerOptions. Runner, budget, timeout and T3 access have board
// defaults (the engine's agentDefaults), which the service lays over the automation's own defaults
// (agentDefaultsFor): a scope only sets them to override the board.

export const RUNNER_OPTION_SHAPE = {
  ...AutopilotAgentDefaults.shape,
  /**
   * The model the run starts on (resolveOperationChoice): inherit takes the board's setting for the operation, then
   * the task's own; or a tier, a custom model, or a model typed for one provider. Before 041_operation_models a typed
   * `model` sat beside it; that migration folded it in.
   */
  modelChoice: ModelChoice,
};

export const RunnerOptions = z.object(RUNNER_OPTION_SHAPE);
export type RunnerOptions = z.infer<typeof RunnerOptions>;

/** The built-in values, under the board's agent defaults. */
export const RUNNER_DEFAULTS: RunnerOptions = { ...DEFAULT_AGENT_DEFAULTS, modelChoice: INHERIT };

export const RUNNER_FIELDS: AutopilotField[] = [
  {
    key: "runner",
    label: "Runner",
    kind: "select",
    help: "Where its runs start.",
    options: RUNNER_CHOICES.map(({ value, label }) => ({ value, label })),
  },
  {
    key: "modelChoice",
    label: "Model",
    kind: "model",
    help: "From Agents → Operations unless set here.",
    info: "Inherit uses the board's model for this kind of run, else the task's own: a custom model one of its labels picks, else its suggested tier. Models are set in Settings → Agents → Models.",
  },
  {
    key: "budgetUsd",
    label: "Headless budget",
    kind: "number",
    min: 0.5,
    max: 100,
    step: 0.5,
    unit: "USD",
    help: "Claude Code only.",
    info: "Codex and Copilot CLI runs have no spending cap and report no cost: only the timeout stops them.",
  },
  {
    key: "timeoutMinutes",
    label: "Headless timeout",
    kind: "number",
    min: 1,
    max: 1440,
    unit: "minutes",
    help: "Stops a run after this long.",
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

/**
 * The runner fields for an automation whose runs are `operation` (asking `needs` beyond it), so its Model field greys
 * out the providers that can't run them.
 */
export const runnerFields = (operation: OperationId, needs: readonly OperationNeed[] = []): AutopilotField[] =>
  RUNNER_FIELDS.map((field) =>
    field.kind === "model" ? { ...field, operation, ...(needs.length > 0 ? { needs: [...needs] } : {}) } : field,
  );

/**
 * The board's agent defaults an automation takes: each one it has a default of its own for, and accepts (Review PRs
 * runs headless only, so a board default of T3 Code leaves its runner alone). Laid over its own defaults, under every
 * scope's config.
 */
export function agentDefaultsFor(
  automation: Pick<Automation, "schema" | "defaults">,
  board: AutopilotAgentDefaults,
): AutomationConfig {
  const shape = automation.schema instanceof z.ZodObject ? (automation.schema.shape as Record<string, z.ZodType>) : {};
  const out: AutomationConfig = {};
  for (const key of AGENT_DEFAULT_KEYS) {
    if (!(key in automation.defaults)) continue;
    const accepts = shape[key];
    if (!accepts || accepts.safeParse(board[key]).success) out[key] = board[key];
  }
  return out;
}

/**
 * The runner options in an automation's config; anything missing or invalid takes the board's agent default, then the
 * built-in one.
 */
export function readRunnerOptions(
  config: Record<string, unknown>,
  board: AutopilotAgentDefaults = DEFAULT_AGENT_DEFAULTS,
): RunnerOptions {
  const out: RunnerOptions = { ...RUNNER_DEFAULTS, ...board };
  for (const key of Object.keys(RUNNER_OPTION_SHAPE) as (keyof RunnerOptions)[]) {
    const parsed = RUNNER_OPTION_SHAPE[key].safeParse(config[key]);
    if (parsed.success) Object.assign(out, { [key]: parsed.data });
  }
  return out;
}
