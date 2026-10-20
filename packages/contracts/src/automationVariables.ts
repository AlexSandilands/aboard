import { z } from "zod";

// Variables for custom automations (docs/features/autopilot.md#variables): named values set board-wide in Settings →
// Autopilot, which a project can override, so one automation reads `{{vars.jira_key}}` instead of branching on the
// project. Kept apart from customAutomations.ts, which imports the project schema this one is part of.

/** The most variables the board, or one project, may set. */
export const AUTOMATION_VARIABLES_MAX = 50;
export const AUTOMATION_VARIABLE_VALUE_MAX = 2_000;

/** What a prompt writes after `vars.` (`{{vars.jira_key}}`): the same rule as an input's name. */
export const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** A named value automations read. Plain text, filled in as it is: never a secret, since dry runs and backups show it. */
export const AutomationVariable = z.object({
  name: z.string().trim().regex(VARIABLE_NAME, "Use lowercase letters, digits and underscores, starting with a letter"),
  value: z.string().max(AUTOMATION_VARIABLE_VALUE_MAX).default(""),
});
export type AutomationVariable = z.infer<typeof AutomationVariable>;

export const AutomationVariables = z
  .array(AutomationVariable)
  .max(AUTOMATION_VARIABLES_MAX, `At most ${AUTOMATION_VARIABLES_MAX} variables`)
  .superRefine((vars, ctx) => {
    const seen = new Set<string>();
    for (const { name } of vars) {
      if (seen.has(name)) ctx.addIssue({ code: "custom", message: `"${name}" is set twice` });
      seen.add(name);
    }
  });
export type AutomationVariables = z.infer<typeof AutomationVariables>;

/**
 * The variables in effect in a project: the board's, with the project's over them. A project that sets a name to an
 * empty value overrides it with nothing, which counts as missing there (variableHasValue).
 */
export function effectiveVariables(
  board: readonly AutomationVariable[],
  project: { variables?: readonly AutomationVariable[] } | null,
): Record<string, string> {
  return Object.fromEntries([...board, ...(project?.variables ?? [])].map((v) => [v.name, v.value]));
}

/** Whether a variable has a value: set, and not blank. */
export const variableHasValue = (vars: Record<string, string>, name: string): boolean =>
  Object.hasOwn(vars, name) && vars[name]!.trim() !== "";
