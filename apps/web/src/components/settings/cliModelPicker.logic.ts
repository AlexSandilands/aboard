import { CliModel, type AgentModel } from "@repo/contracts";

// The model picker of a CLI on the Model tiers page: the models the CLI lists, searchable, plus whatever is typed.

/** The models to list: the scanned ones, then the saved one when the scan doesn't have it, so it is still shown. */
export function suggestedModels(models: readonly AgentModel[], saved: string): AgentModel[] {
  const value = saved.trim();
  if (!value || models.some((m) => m.value === value)) return [...models];
  return [...models, { value, label: null, description: null, effortLevels: null }];
}

/** The models matching the search: any part of their value, name or description, ignoring case. Blank lists all. */
export function filterModels(models: readonly AgentModel[], query: string): AgentModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((m) => [m.value, m.label, m.description].some((text) => text?.toLowerCase().includes(needle)));
}

export type TypedModel =
  /** The search text can be used as a model of its own. */
  | { kind: "use"; value: string }
  /** The text can't go on a command line. */
  | { kind: "invalid"; error: string };

/**
 * The search text offered as a model the list doesn't have (e.g. `claude-opus-5-5` or `sonnet[1m]`). Null when it is
 * blank or is exactly a listed model, which is picked from the list instead.
 */
export function typedModel(query: string, models: readonly AgentModel[]): TypedModel | null {
  const text = query.trim();
  if (!text || models.some((m) => m.value === text)) return null;
  return CliModel.safeParse(text).success
    ? { kind: "use", value: text }
    : { kind: "invalid", error: "A model name has only letters, digits and . : @ / [ ] -" };
}

/** The suggestion for a model value, if the scan listed it. */
export const findSuggestion = (models: readonly AgentModel[], value: string): AgentModel | undefined =>
  models.find((m) => m.value === value.trim());
