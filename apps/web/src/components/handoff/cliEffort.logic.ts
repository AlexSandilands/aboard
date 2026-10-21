import { CLI_EFFORTS, type AgentHarness, type CliEffort } from "@repo/contracts";

// The effort select next to a CLI model, in the launch dialogs and on the Model tiers page.

/** The select's value for "the CLI's own default effort", which a Select can't hold as null. */
export const DEFAULT_EFFORT = "default";

const EFFORT_LABELS: Record<CliEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A level as the pickers show it. */
export const effortLabel = (level: CliEffort): string => EFFORT_LABELS[level];

export interface EffortItem {
  value: string;
  label: string;
}

/**
 * What the select lists: "Default effort", then the levels the model takes. A level already chosen that the list no
 * longer has (the model changed) stays, so what is saved can still be seen and cleared.
 */
export function effortItems(levels: readonly CliEffort[], current: CliEffort | null): EffortItem[] {
  const shown = current && !levels.includes(current) ? [current, ...levels] : levels;
  return [
    { value: DEFAULT_EFFORT, label: "Default effort" },
    ...shown.map((level) => ({ value: level, label: effortLabel(level) })),
  ];
}

/** The level a select value stands for: null for the default, or anything that isn't a level. */
export const effortOfValue = (value: unknown): CliEffort | null => {
  const parsed = typeof value === "string" ? CLI_EFFORT_VALUES.find((level) => level === value) : undefined;
  return parsed ?? null;
};

const CLI_EFFORT_VALUES: readonly CliEffort[] = [...new Set(Object.values(CLI_EFFORTS).flat())];

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
