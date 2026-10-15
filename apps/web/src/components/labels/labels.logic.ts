import { normalizeLabel, type TaskSummary } from "@repo/contracts";
import type { CSSProperties } from "react";

/**
 * Hues offered as swatches in the colour picker, in OKLCH degrees: red, orange, amber, lime, green, teal,
 * cyan, blue, indigo, violet, magenta, pink.
 */
export const SUGGESTED_HUES: ReadonlyArray<number> = [25, 55, 85, 125, 150, 180, 210, 250, 275, 300, 330, 355];

/** A stable hue for a label without an override (FNV-1a over its UTF-16 code units). */
export function hashHue(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

/** The label's override, else its hashed hue. */
export function labelHue(label: string, colors: Readonly<Record<string, number>>): number {
  return colors[label] ?? hashHue(label);
}

/**
 * The `--label` colour for Badge's `label` variant, which tints the chip from it per theme. Only the hue varies:
 * fixed lightness and chroma keep picked and hashed colours equally readable.
 */
export function labelStyle(hue: number): CSSProperties {
  return { "--label": `oklch(0.62 0.16 ${hue})` } as CSSProperties;
}

/** A hue at least 40° away from `current`, for the picker's shuffle. `random` is injectable for tests. */
export function shuffleHue(current: number, random: () => number = Math.random): number {
  const offset = 40 + Math.floor(random() * 281); // 40..320
  return (current + offset) % 360;
}

/** How many tasks carry each label, sorted by name. */
export function labelCounts(tasks: ReadonlyArray<TaskSummary>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) for (const label of task.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface LabelSuggestions {
  /** Labels in use that match the query and the task doesn't have yet. */
  existing: string[];
  /** The normalised query, offered as a new label when no existing label matches it exactly. */
  create: string | null;
}

/** Suggestions for the "Add label" input. */
export function suggestLabels(
  query: string,
  inUse: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
): LabelSuggestions {
  const normalized = normalizeLabel(query);
  const available = inUse.filter((label) => !current.includes(label));
  const existing = normalized ? available.filter((label) => label.includes(normalized)) : available;
  // Exact matches first, then prefix matches, then the rest, each in name order.
  const rank = (label: string) => (label === normalized ? 0 : label.startsWith(normalized) ? 1 : 2);
  existing.sort((a, b) => rank(a) - rank(b));
  const create = normalized && !inUse.includes(normalized) && !current.includes(normalized) ? normalized : null;
  return { existing, create };
}

/** `?labels=` value → label list (normalised, deduped, empties dropped). */
export function parseLabelFilter(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map(normalizeLabel).filter(Boolean))];
}

/** Label list → `?labels=` value; undefined drops the param. */
export function formatLabelFilter(labels: ReadonlyArray<string>): string | undefined {
  return labels.length ? labels.join(",") : undefined;
}

/** Adds the label to the selection, or removes it if it is already there. */
export function toggleLabel(selected: ReadonlyArray<string>, label: string): string[] {
  return selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label];
}
