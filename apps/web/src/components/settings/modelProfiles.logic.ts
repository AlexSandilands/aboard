// Pure helpers for the Custom models list on the Model tiers page: adding, editing, reordering and removing a custom
// model, and the list one edit sends.
import {
  LABEL_MAX_LENGTH,
  MODEL_PROFILE_NAME_MAX,
  MODEL_PROFILES_MAX,
  MODEL_PROFILE_LABELS_MAX,
  ModelTier,
  normalizeLabel,
  type ModelProfile,
} from "@repo/contracts";
import { applyTierChange, type TierChange } from "./modelTiers.logic";

/** One edit to the list: a new model, a field of one, a move, or a removal. */
export type ProfileEdit =
  | { kind: "add"; name: string }
  | {
      kind: "change";
      id: string;
      change: TierChange | { field: "name"; value: string } | { field: "labels"; value: string[] };
    }
  | { kind: "move"; id: string; delta: -1 | 1 }
  | { kind: "remove"; id: string };

/**
 * An id for a new model from its name, e.g. "Codex 6.1" -> "codex-6-1": lowercase, never a tier's name, and not one
 * the list already has.
 */
export function profileIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "model";
  const start = ModelTier.safeParse(base).success ? `${base}-model` : base;
  let id = start;
  for (let n = 2; taken.has(id); n++) id = `${start}-${n}`;
  return id;
}

/**
 * "codex61, #Fast lane" -> ["codex61", "fast-lane"]: commas separate labels, each normalised as a task label is. One
 * longer than a label can be is dropped, as no task could carry it and the server would refuse the whole list.
 */
export function parseLabelList(text: string): string[] {
  const labels = text
    .split(",")
    .map(normalizeLabel)
    .filter((label) => label && label.length <= LABEL_MAX_LENGTH);
  return [...new Set(labels)].slice(0, MODEL_PROFILE_LABELS_MAX);
}

/** The list with the edit applied; unchanged when it names a model that isn't there or the list is full. */
export function applyProfileEdit(list: readonly ModelProfile[], edit: ProfileEdit): ModelProfile[] {
  switch (edit.kind) {
    case "add": {
      if (list.length >= MODEL_PROFILES_MAX) return [...list];
      const name = edit.name.trim() || "New model";
      const id = profileIdFor(name, new Set(list.map((p) => p.id)));
      return [...list, { id, name, labels: [], description: null, t3: null }];
    }
    case "change":
      return list.map((profile) => {
        if (profile.id !== edit.id) return profile;
        const { change } = edit;
        if (change.field === "name") {
          return { ...profile, name: change.value.trim().slice(0, MODEL_PROFILE_NAME_MAX).trim() || profile.name };
        }
        if (change.field === "labels") return { ...profile, labels: change.value };
        return { ...profile, ...applyTierChange(profile, change) };
      });
    case "move": {
      const from = list.findIndex((p) => p.id === edit.id);
      const to = from + edit.delta;
      if (from < 0 || to < 0 || to >= list.length) return [...list];
      const next = [...list];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    }
    case "remove":
      return list.filter((p) => p.id !== edit.id);
  }
}

/**
 * Labels more than one model claims, with the model that wins each (the first in the list, as the board resolves it)
 * and the ones it shadows.
 */
export function labelConflicts(
  list: readonly ModelProfile[],
): Array<{ label: string; winner: string; shadowed: string[] }> {
  const owners = new Map<string, string[]>();
  for (const profile of list) {
    for (const label of profile.labels) owners.set(label, [...(owners.get(label) ?? []), profile.name]);
  }
  return [...owners]
    .filter(([, names]) => names.length > 1)
    .map(([label, [winner, ...shadowed]]) => ({ label, winner: winner!, shadowed }));
}

/**
 * Builds the list each edit sends. The server replaces the whole list and the cached settings only catch up once it
 * replies, so an edit made while another is saving builds on the list last sent, not the stale cache (the same
 * reasoning as createTierEdits).
 */
export function createProfileEdits() {
  let pending: { value: ModelProfile[]; inflight: number } | null = null;
  return {
    compose(cached: readonly ModelProfile[], edit: ProfileEdit): ModelProfile[] {
      const value = applyProfileEdit(pending?.value ?? cached, edit);
      pending = { value, inflight: (pending?.inflight ?? 0) + 1 };
      return value;
    },
    settle(): void {
      if (!pending) return;
      if (pending.inflight <= 1) pending = null;
      else pending.inflight -= 1;
    },
  };
}

export type ProfileEdits = ReturnType<typeof createProfileEdits>;

/** Saves one edit, settling when the save ends either way; whoever owns `send` reports a failure. */
export function saveProfileEdit(
  edits: ProfileEdits,
  send: (update: { modelProfiles: ModelProfile[] }) => Promise<unknown>,
  cached: readonly ModelProfile[],
  edit: ProfileEdit,
): Promise<void> {
  const next = edits.compose(cached, edit);
  return send({ modelProfiles: next }).then(
    () => edits.settle(),
    () => edits.settle(),
  );
}
