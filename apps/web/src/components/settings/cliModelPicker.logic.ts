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

/**
 * The model Enter picks in the search: the listed model it names exactly (`sonnet` while `sonnet[1m]` matches too),
 * else the only listed model it matches, else what was typed when nothing is listed for it. Null for a blank search,
 * an invalid name, or several matches.
 */
export function enterPick(query: string, listed: readonly AgentModel[]): string | null {
  const text = query.trim();
  if (!text) return null;
  const exact = listed.find((m) => m.value === text);
  if (exact) return exact.value;
  const shown = filterModels(listed, text);
  if (shown.length === 1) return shown[0]!.value;
  if (shown.length > 1) return null;
  const typed = typedModel(text, listed);
  return typed?.kind === "use" ? typed.value : null;
}

/**
 * Where an arrow key moves focus in the picker: from the search (-1) down into the rows, between rows, and from the
 * first row back up to the search. Stays put at the last row.
 */
export function arrowTarget(from: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (key === "ArrowDown") return Math.min(from + 1, count - 1);
  return Math.max(from - 1, -1);
}

/** The suggestion for a model value, if the scan listed it. */
export const findSuggestion = (models: readonly AgentModel[], value: string): AgentModel | undefined =>
  models.find((m) => m.value === value.trim());
