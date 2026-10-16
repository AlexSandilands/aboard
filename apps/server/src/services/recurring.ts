import {
  nextDue,
  type CreateRecurringRuleInput,
  type RecurringRule,
  type RecurringRuleView,
  type UpdateRecurringRuleInput,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { ProjectsService, TemplatesService } from "./types.ts";

/** What the Recurring tasks automation records about a slot it dealt with. */
export interface RecurringHandled {
  /** The slot, an ISO time; the rule won't look for slots up to here again. */
  dueAt: string;
  /** The task created for it, if any. */
  taskId?: string;
}

/** The rules of the Recurring tasks automation, per project (docs/features/autopilot.md). Edited by the user only. */
export interface RecurringService {
  /** A project's rules, oldest first, with when each is next due. */
  list(projectId: string): RecurringRuleView[];
  get(id: string): RecurringRule;
  /** Throws NOT_FOUND for an unknown project or template, VALIDATION for one the project can't use, CONFLICT for a name taken. */
  create(projectId: string, input: CreateRecurringRuleInput): RecurringRuleView;
  /**
   * Switching a rule on, or changing its schedule, starts it from now: slots that passed meanwhile are not caught up.
   */
  update(id: string, input: UpdateRecurringRuleInput): RecurringRuleView;
  delete(id: string): void;
  /** Records that the automation dealt with a slot (created a task, skipped it or failed), so the next one is after it. */
  handled(id: string, done: RecurringHandled): void;
}

/** The rule as the API returns it. */
const viewOf = (rule: RecurringRule): RecurringRuleView => ({
  ...rule,
  nextDueAt: nextDue(rule.schedule, new Date(rule.lastDueAt))?.toISOString() ?? null,
});

export function createRecurringService(
  core: Core,
  deps: { projects: ProjectsService; templates: TemplatesService },
): RecurringService {
  const { repos } = core;

  const get = (id: string): RecurringRule => {
    const rule = repos.autopilotRecurring.get(id);
    if (!rule) throw notFound("Recurring rule", id);
    return rule;
  };

  /** The template must be one the project can use, and give the tasks a title. */
  const assertTemplate = (templateId: string, projectId: string) => {
    const template = deps.templates.get(templateId);
    if (template.projectId !== null && template.projectId !== projectId) {
      throw new AppError("VALIDATION", `Template "${template.name}" belongs to another project`);
    }
    if (!template.titlePattern.trim()) {
      throw new AppError(
        "VALIDATION",
        `Template "${template.name}" has no title pattern, so the tasks it makes would have no title`,
      );
    }
  };

  const assertNameFree = (projectId: string, name: string, selfId?: string) => {
    const taken = repos.autopilotRecurring.byName(projectId, name);
    if (taken && taken.id !== selfId) {
      throw new AppError("CONFLICT", `This project already has a recurring rule called "${taken.name}"`);
    }
  };

  return {
    list: (projectId) => repos.autopilotRecurring.forProject(deps.projects.get(projectId).id).map(viewOf),

    get,

    create(projectId, input) {
      return core.write((fx) => {
        const project = deps.projects.get(projectId);
        assertTemplate(input.templateId, project.id);
        assertNameFree(project.id, input.name);
        const now = nowIso();
        const rule: RecurringRule = {
          id: randomUUID(),
          projectId: project.id,
          name: input.name,
          templateId: input.templateId,
          schedule: input.schedule,
          flagAutopilot: input.flagAutopilot ?? false,
          enabled: input.enabled ?? true,
          lastDueAt: now,
          lastTaskId: null,
          createdAt: now,
          updatedAt: now,
        };
        repos.autopilotRecurring.insert(rule);
        fx.autopilot();
        return viewOf(rule);
      });
    },

    update(id, input) {
      return core.write((fx) => {
        const current = get(id);
        const templateId = input.templateId ?? current.templateId;
        if (input.templateId !== undefined) assertTemplate(input.templateId, current.projectId);
        const name = input.name ?? current.name;
        if (name !== current.name) assertNameFree(current.projectId, name, id);
        const schedule = input.schedule ?? current.schedule;
        const enabled = input.enabled ?? current.enabled;
        const now = nowIso();
        const next: RecurringRule = {
          ...current,
          name,
          templateId,
          schedule,
          flagAutopilot: input.flagAutopilot ?? current.flagAutopilot,
          enabled,
          // Slots that passed while the rule was off, or under another schedule, aren't owed.
          lastDueAt:
            (enabled && !current.enabled) || JSON.stringify(schedule) !== JSON.stringify(current.schedule)
              ? now
              : current.lastDueAt,
          updatedAt: now,
        };
        repos.autopilotRecurring.update(next);
        fx.autopilot();
        return viewOf(next);
      });
    },

    delete(id) {
      core.write((fx) => {
        get(id);
        repos.autopilotRecurring.delete(id);
        fx.autopilot();
      });
    },

    handled(id, done) {
      core.write((fx) => {
        const current = repos.autopilotRecurring.get(id);
        if (!current) return;
        // Never backwards: a slot handled late must not reopen the ones after it.
        const lastDueAt = done.dueAt > current.lastDueAt ? done.dueAt : current.lastDueAt;
        repos.autopilotRecurring.update({
          ...current,
          lastDueAt,
          lastTaskId: done.taskId ?? current.lastTaskId,
          updatedAt: nowIso(),
        });
        fx.autopilot();
      });
    },
  };
}
