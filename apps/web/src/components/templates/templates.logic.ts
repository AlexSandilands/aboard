import {
  normalizeLabel,
  renderTemplateText,
  templateHasPlan,
  type CreateTemplateInput,
  type ModelTier,
  type Project,
  type TaskDetail,
  type TaskTemplate,
  type TemplatePhase,
} from "@repo/contracts";
import { nextOutlineKey, planInputFromOutline, type OutlinePhase } from "~/components/task/plan.logic";

/** A template as the editor holds it: text fields as typed, the plan as an outline. */
export interface TemplateForm {
  name: string;
  /** null makes it available on every project. */
  projectId: string | null;
  titlePattern: string;
  description: string;
  /** Comma-separated, as typed. */
  labels: string;
  planContext: string;
  suggestedTier: ModelTier | null;
  outline: OutlinePhase[];
}

const outlineOf = (phases: ReadonlyArray<TemplatePhase>): OutlinePhase[] =>
  phases.map((phase) => ({
    key: nextOutlineKey(),
    title: phase.title,
    steps: phase.steps.map((step) => ({
      key: nextOutlineKey(),
      title: step.title,
      ...(step.notes ? { notes: step.notes } : {}),
    })),
  }));

export function emptyForm(): TemplateForm {
  return {
    name: "",
    projectId: null,
    titlePattern: "",
    description: "",
    labels: "",
    planContext: "",
    suggestedTier: null,
    outline: [],
  };
}

export function formFromTemplate(template: TaskTemplate): TemplateForm {
  return {
    name: template.name,
    projectId: template.projectId,
    titlePattern: template.titlePattern,
    description: template.description ?? "",
    labels: template.labels.join(", "),
    planContext: template.planContext ?? "",
    suggestedTier: template.suggestedTier,
    outline: outlineOf(template.phases),
  };
}

/** A draft (from "Save as template") as the editor holds it. */
export function formFromDraft(draft: CreateTemplateInput): TemplateForm {
  return {
    name: draft.name,
    projectId: draft.projectId ?? null,
    titlePattern: draft.titlePattern ?? "",
    description: draft.description ?? "",
    labels: (draft.labels ?? []).join(", "),
    planContext: draft.planContext ?? "",
    suggestedTier: draft.suggestedTier ?? null,
    outline: outlineOf(draft.phases ?? []),
  };
}

/** Labels typed as "ui, back end": normalised, blanks dropped, duplicates removed. */
export function parseLabels(text: string): string[] {
  const labels = text
    .split(",")
    .map(normalizeLabel)
    .filter((label) => label !== "");
  return [...new Set(labels)];
}

export type FormResult = { ok: true; input: CreateTemplateInput } | { ok: false; error: string };

/** The server's input for a form; blank text becomes null, and steps left empty are dropped from the plan. */
export function formToInput(form: TemplateForm): FormResult {
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give the template a name" };
  const plan = planInputFromOutline(form.outline);
  const phases: TemplatePhase[] = (plan?.phases ?? []).map((phase) => ({
    title: phase.title,
    steps: phase.steps.map((step) => ({ title: step.title, ...(step.notes ? { notes: step.notes } : {}) })),
  }));
  return {
    ok: true,
    input: {
      name,
      projectId: form.projectId,
      titlePattern: form.titlePattern.trim(),
      description: form.description.trim() ? form.description : null,
      labels: parseLabels(form.labels),
      planContext: form.planContext.trim() ? form.planContext : null,
      phases,
      suggestedTier: form.suggestedTier,
    },
  };
}

/** A template that starts from a task: its title, description, labels and plan, with progress left behind. */
export function draftFromTask(
  task: Pick<
    TaskDetail,
    "title" | "description" | "labels" | "planContext" | "phases" | "suggestedModel" | "projectId"
  >,
): CreateTemplateInput {
  return {
    name: task.title,
    projectId: task.projectId,
    titlePattern: task.title,
    description: task.description,
    labels: task.labels,
    planContext: task.planContext,
    phases: task.phases
      .filter((phase) => phase.steps.length > 0)
      .map((phase) => ({
        title: phase.title,
        steps: phase.steps.map((step) => ({ title: step.title, ...(step.notes ? { notes: step.notes } : {}) })),
      })),
    suggestedTier: task.suggestedModel?.tier ?? null,
  };
}

/** Templates a task in `projectId` can use: the board-wide ones, then the project's own. */
export function templatesFor(templates: ReadonlyArray<TaskTemplate>, projectId: string): TaskTemplate[] {
  return [...templates.filter((t) => t.projectId === null), ...templates.filter((t) => t.projectId === projectId)];
}

/** The title and description a template pre-fills for a new task in `project`. */
export function prefillFrom(
  template: Pick<TaskTemplate, "titlePattern" | "description">,
  project: Pick<Project, "title">,
  date: Date = new Date(),
): { title: string; description: string } {
  const context = { date, project: project.title };
  return {
    title: renderTemplateText(template.titlePattern, context).trim(),
    description: renderTemplateText(template.description ?? "", context),
  };
}

/**
 * What a field holds after the template changes. A field the user hasn't touched (empty, or still what the last
 * template put there) follows the template; one they've edited stays.
 */
export function followTemplate(current: string, applied: string, next: string): string {
  return current.trim() === "" || current === applied ? next : current;
}

/** "3 steps · bug, ui", for a template's row. */
export function templateSummary(template: TaskTemplate): string {
  const steps = template.phases.reduce((n, phase) => n + phase.steps.length, 0);
  const parts = [
    templateHasPlan(template) ? `${steps} ${steps === 1 ? "step" : "steps"}` : "No plan",
    template.labels.length ? template.labels.join(", ") : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** "All projects", or the project's title. */
export function scopeLabel(template: Pick<TaskTemplate, "projectId">, projects: ReadonlyArray<Project>): string {
  if (template.projectId === null) return "All projects";
  return projects.find((p) => p.id === template.projectId)?.title ?? "A project";
}
