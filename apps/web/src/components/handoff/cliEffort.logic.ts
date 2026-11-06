import type { AgentHarness, CliEffort } from "@repo/contracts";

// The effort that goes with a CLI model, in the launch dialogs and on the Models page.

const EFFORT_LABELS: Record<CliEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** A level as the pickers show it. */
export const effortLabel = (level: CliEffort): string => EFFORT_LABELS[level];

/**
 * The effort a launch starts with: the one set for the task's model, as the model is. Planning keeps the CLI's default
 * model, so it keeps the default effort too.
 */
export function initialEffort(
  options: { efforts?: Partial<Record<AgentHarness, CliEffort | null>> | undefined },
  harness: AgentHarness,
  plan: boolean,
): CliEffort | null {
  return plan ? null : (options.efforts?.[harness] ?? null);
}

/** The effort to keep after the model changed: kept while the model still takes it, else the default. */
export function effortAfterModelChange(effort: CliEffort | null, levels: readonly CliEffort[]): CliEffort | null {
  return effort && levels.includes(effort) ? effort : null;
}
