import { z } from "zod";
import { ModelTier } from "./modelTiers.ts";

// A template is the starting point for a task: a title pattern, a description, labels and, optionally, a plan.
// Creating a task copies these fields, so later edits to a template leave existing tasks alone.

export const TEMPLATE_NAME_MAX = 80;

export const TemplateStep = z.object({
  title: z.string().trim().min(1),
  notes: z.string().nullable().optional(),
});
export type TemplateStep = z.infer<typeof TemplateStep>;

export const TemplatePhase = z.object({
  title: z.string().trim().min(1),
  steps: z.array(TemplateStep),
});
export type TemplatePhase = z.infer<typeof TemplatePhase>;

export const TaskTemplate = z.object({
  id: z.string(),
  name: z.string(),
  /** The project it belongs to; null makes it available on every project. */
  projectId: z.string().nullable(),
  /** Used as the title when none is given. May hold {{date}} and {{project}}. */
  titlePattern: z.string(),
  description: z.string().nullable(),
  /** Normalised labels. */
  labels: z.array(z.string()),
  planContext: z.string().nullable(),
  /** The starting plan; empty for a template without one. */
  phases: z.array(TemplatePhase),
  suggestedTier: ModelTier.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskTemplate = z.infer<typeof TaskTemplate>;

const TemplateFields = {
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
  titlePattern: z.string().trim().optional(),
  description: z.string().nullable().optional(),
  /** Normalised by the server; see normalizeLabels. */
  labels: z.array(z.string()).optional(),
  planContext: z.string().nullable().optional(),
  phases: z.array(TemplatePhase).optional(),
  suggestedTier: ModelTier.nullable().optional(),
};

export const CreateTemplateInput = z.object({
  ...TemplateFields,
  /** Omit or null for a board-wide template. */
  projectId: z.string().nullable().optional(),
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

export const UpdateTemplateInput = z
  .object({ ...TemplateFields, projectId: z.string().nullable().optional() })
  .partial();
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInput>;

export const templateHasPlan = (template: Pick<TaskTemplate, "phases">): boolean =>
  template.phases.some((phase) => phase.steps.length > 0);

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD. */
export const isoDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export interface TemplateContext {
  /** The day the task is created on. */
  date: Date;
  /** The title of the project the task lands in. */
  project: string;
}

/** The placeholders a template's title and description may use. */
export const TEMPLATE_PLACEHOLDERS = [
  { token: "{{date}}", description: "Today's date, e.g. 2026-10-16" },
  { token: "{{project}}", description: "The title of the project the task is created in" },
] as const;

/** Fills {{date}} and {{project}}; any other `{{…}}` is left as written. */
export function renderTemplateText(text: string, context: TemplateContext): string {
  return text.replace(/\{\{\s*(date|project)\s*\}\}/gi, (_match, key: string) =>
    key.toLowerCase() === "date" ? isoDate(context.date) : context.project,
  );
}
