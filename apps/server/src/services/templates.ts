import {
  TEMPLATE_NAME_MAX,
  normalizeLabels,
  type CreateTemplateInput,
  type TaskTemplate,
  type TemplatePhase,
  type UpdateTemplateInput,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { ProjectsService, TemplatesService } from "./types.ts";

function toLabels(raw: readonly string[]): string[] {
  try {
    return normalizeLabels(raw);
  } catch (error) {
    throw new AppError("VALIDATION", error instanceof Error ? error.message : "Invalid labels");
  }
}

/** Phases without steps are dropped: a plan needs steps, and an empty phase in a template is a leftover. */
const keepFilledPhases = (phases: readonly TemplatePhase[]): TemplatePhase[] =>
  phases
    .filter((phase) => phase.steps.length > 0)
    .map((phase) => ({
      title: phase.title,
      steps: phase.steps.map((step) => ({ title: step.title, ...(step.notes ? { notes: step.notes } : {}) })),
    }));

/** Templates for new tasks: board-wide or per project, edited by the user and read by agents. */
export function createTemplatesService(core: Core, deps: { projects: ProjectsService }): TemplatesService {
  const { repos } = core;

  const get = (id: string): TaskTemplate => {
    const template = repos.templates.get(id);
    if (!template) throw notFound("Template", id);
    return template;
  };

  /** One name per scope, ignoring case, so a name picks one template on a project. */
  const assertNameFree = (name: string, projectId: string | null, selfId?: string) => {
    const existing = repos.templates.byName(name, projectId);
    if (existing && existing.id !== selfId) {
      throw new AppError(
        "CONFLICT",
        `${projectId ? "This project" : "The board"} already has a template called "${existing.name}"`,
      );
    }
  };

  const scopeOf = (projectId: string | null | undefined): string | null =>
    projectId ? deps.projects.get(projectId).id : null;

  const list: TemplatesService["list"] = (opts) => {
    const all = repos.templates.list();
    return opts?.projectId ? all.filter((t) => t.projectId === null || t.projectId === opts.projectId) : all;
  };

  return {
    list,

    get,

    resolve(ref, projectId) {
      const trimmed = ref.trim();
      const byId = repos.templates.get(trimmed);
      if (byId && (byId.projectId === null || byId.projectId === projectId)) return byId;
      const byName = repos.templates.byName(trimmed, projectId) ?? repos.templates.byName(trimmed, null);
      if (byName) return byName;
      const known = list({ projectId }).map((t) => t.name);
      throw new AppError(
        "NOT_FOUND",
        `Template not found: ${trimmed}. ${known.length ? `Available here: ${known.join(", ")}.` : "There are none."}`,
      );
    },

    create(input: CreateTemplateInput) {
      return core.write(() => {
        const projectId = scopeOf(input.projectId);
        assertNameFree(input.name, projectId);
        const now = nowIso();
        const template: TaskTemplate = {
          id: randomUUID(),
          name: input.name,
          projectId,
          titlePattern: input.titlePattern ?? "",
          description: input.description?.trim() ? input.description : null,
          labels: toLabels(input.labels ?? []),
          planContext: input.planContext?.trim() ? input.planContext : null,
          phases: keepFilledPhases(input.phases ?? []),
          suggestedTier: input.suggestedTier ?? null,
          createdAt: now,
          updatedAt: now,
        };
        repos.templates.insert(template);
        return template;
      });
    },

    update(id, input: UpdateTemplateInput) {
      return core.write(() => {
        const current = get(id);
        const projectId = input.projectId !== undefined ? scopeOf(input.projectId) : current.projectId;
        const name = input.name ?? current.name;
        if (name !== current.name || projectId !== current.projectId) assertNameFree(name, projectId, id);
        const next: TaskTemplate = {
          ...current,
          name,
          projectId,
          titlePattern: input.titlePattern ?? current.titlePattern,
          description:
            input.description !== undefined
              ? input.description?.trim()
                ? input.description
                : null
              : current.description,
          labels: input.labels !== undefined ? toLabels(input.labels) : current.labels,
          planContext:
            input.planContext !== undefined
              ? input.planContext?.trim()
                ? input.planContext
                : null
              : current.planContext,
          phases: input.phases !== undefined ? keepFilledPhases(input.phases) : current.phases,
          suggestedTier: input.suggestedTier !== undefined ? input.suggestedTier : current.suggestedTier,
          updatedAt: nowIso(),
        };
        repos.templates.update(next);
        return next;
      });
    },

    duplicate(id) {
      return core.write(() => {
        const source = get(id);
        // The base is cut so "<name> copy 12" still fits the name limit.
        const base = source.name.slice(0, TEMPLATE_NAME_MAX - " copy 99".length).trimEnd();
        let name = `${base} copy`;
        for (let n = 2; repos.templates.byName(name, source.projectId); n++) name = `${base} copy ${n}`;
        const now = nowIso();
        const copy: TaskTemplate = { ...source, id: randomUUID(), name, createdAt: now, updatedAt: now };
        repos.templates.insert(copy);
        return copy;
      });
    },

    delete(id) {
      core.write(() => {
        get(id);
        repos.templates.delete(id);
      });
    },
  };
}
