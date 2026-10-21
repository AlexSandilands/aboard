import { CliModel, type AgentModel } from "@repo/contracts";

// The model field of a CLI on the Model tiers page: a text field that suggests the models the CLI lists.

/** The models to suggest: the scanned ones, then the saved one when the scan doesn't have it, so it is still shown. */
export function suggestedModels(models: readonly AgentModel[], saved: string): AgentModel[] {
  const value = saved.trim();
  if (!value || models.some((m) => m.value === value)) return [...models];
  return [...models, { value, label: null, description: null, effortLevels: null }];
}

/**
 * Whether a suggestion matches what was typed: any part of its value, name or description, ignoring case. Typing
 * exactly the saved model (which is what the field shows when it opens) lists everything, so another can be picked.
 */
export function modelMatches(model: AgentModel, query: string, saved: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle || query === saved) return true;
  return [model.value, model.label, model.description].some((text) => text?.toLowerCase().includes(needle));
}

export type ModelCommit =
  /** Nothing to save: the text is what is saved already. */
  | { kind: "none" }
  /** Save this model, or null to clear it (the CLI's default). */
  | { kind: "save"; value: string | null }
  /** The text can't go on a command line; it is left in the field with the reason. */
  | { kind: "invalid"; error: string };

/** What leaving the field with `draft` does, given the saved model. */
export function commitModel(draft: string, saved: string): ModelCommit {
  const text = draft.trim();
  if (text === saved.trim()) return { kind: "none" };
  if (!text) return { kind: "save", value: null };
  return CliModel.safeParse(text).success
    ? { kind: "save", value: text }
    : { kind: "invalid", error: "A model name has only letters, digits and . : @ / [ ] -" };
}

/** The suggestion for a model value, if the scan listed it. */
export const findSuggestion = (models: readonly AgentModel[], value: string): AgentModel | undefined =>
  models.find((m) => m.value === value.trim());
