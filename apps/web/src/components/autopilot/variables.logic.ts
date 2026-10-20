import {
  AutomationVariables,
  effectiveVariables,
  missingVariables,
  variableHasValue,
  variablesNamedBy,
  type AutomationVariable,
  type CustomAction,
  type Project,
} from "@repo/contracts";

/** A variable as the editor holds it: both fields as typed. */
export interface VariableRow {
  name: string;
  value: string;
}

export const blankVariable = (): VariableRow => ({ name: "", value: "" });

/** The rows to save, or what to fix. A row with neither a name nor a value is left out, so an added row can stay empty. */
export function rowsToVariables(
  rows: readonly VariableRow[],
): { ok: true; variables: AutomationVariable[] } | { ok: false; error: string } {
  const kept = rows
    .map((row) => ({ name: row.name.trim(), value: row.value }))
    .filter((row) => row.name !== "" || row.value.trim() !== "");
  const parsed = AutomationVariables.safeParse(kept);
  if (parsed.success) return { ok: true, variables: parsed.data };
  const issue = parsed.error.issues[0]!;
  const row = issue.path[0];
  const named = typeof row === "number" ? kept[row]?.name : undefined;
  return {
    ok: false,
    error:
      typeof row === "number" ? `${named ? `"${named}"` : `Variable ${row + 1}`}: ${issue.message}` : issue.message,
  };
}

/** Whether the rows say something other than what is saved. */
export function variablesChanged(rows: readonly VariableRow[], saved: readonly AutomationVariable[]): boolean {
  const parsed = rowsToVariables(rows);
  if (!parsed.ok) return true;
  return JSON.stringify(parsed.variables) !== JSON.stringify(saved);
}

/** The board's variables a project's rows don't override: shown as inherited, each with a way to override it. */
export const inheritedVariables = (
  board: readonly AutomationVariable[],
  rows: readonly VariableRow[],
): AutomationVariable[] => board.filter((v) => !rows.some((row) => row.name.trim() === v.name));

/**
 * What the editor or the import page says about the variables an action names: each with the projects that have no
 * value for it, out of `projects` (the ones it could run in).
 */
export function variableNeeds(
  action: CustomAction,
  board: readonly AutomationVariable[],
  projects: readonly Pick<Project, "id" | "title" | "variables">[],
): Array<{ name: string; missingIn: string[] }> {
  const vars = projects.map((project) => ({ project, vars: effectiveVariables(board, project) }));
  return variablesNamedBy(action).map((name) => ({
    name,
    missingIn: vars.filter((p) => !variableHasValue(p.vars, name)).map((p) => p.project.title),
  }));
}

/** The variables an action names that `project` has no value for, as the engine would skip it. */
export const missingIn = (
  action: CustomAction,
  board: readonly AutomationVariable[],
  project: Pick<Project, "variables"> | null,
): string[] => missingVariables(action, effectiveVariables(board, project));
