import { z } from "zod";

/** Longest label after normalising. */
export const LABEL_MAX_LENGTH = 32;
/** Most labels one task can carry. */
export const LABELS_PER_TASK_MAX = 10;

/**
 * Canonical form of a label, so "UI", " ui " and "#ui" are one label: lowercased, a leading "#" dropped,
 * runs of whitespace and commas turned into a single "-" (commas separate labels in `?labels=a,b`).
 * Returns "" when nothing is left.
 */
export function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[\s,]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalises and dedupes a label list, keeping first-seen order. Throws a message (not an AppError: contracts has
 * no error type) for an empty or over-long label, or too many labels; callers turn it into their own error.
 */
export function normalizeLabels(raw: readonly string[]): string[] {
  const labels: string[] = [];
  for (const value of raw) {
    const label = normalizeLabel(value);
    if (!label) throw new Error(`Label "${value}" is empty once normalised`);
    if (label.length > LABEL_MAX_LENGTH) {
      throw new Error(`Label "${label}" is longer than ${LABEL_MAX_LENGTH} characters`);
    }
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length > LABELS_PER_TASK_MAX) throw new Error(`A task can have at most ${LABELS_PER_TASK_MAX} labels`);
  return labels;
}

/** Hue in degrees for a label colour override. */
export const LabelHue = z.number().int().min(0).max(359);

export const SetLabelColorInput = z.object({ hue: LabelHue });
export type SetLabelColorInput = z.infer<typeof SetLabelColorInput>;

/** A label in use, with how many non-archived tasks carry it and its colour override, if any. */
export const LabelUsage = z.object({ name: z.string(), count: z.number().int(), hue: LabelHue.nullable() });
export type LabelUsage = z.infer<typeof LabelUsage>;
