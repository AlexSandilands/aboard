import {
  AUTOPILOT_RECURRING,
  latestDue,
  localStamp,
  templateHasPlan,
  type RecurringRule,
  type TaskSummary,
} from "@repo/contracts";
import { z } from "zod";
import type { Services } from "../../services/types.ts";
import { defineAutomation, type Candidate } from "../types.ts";

export { AUTOPILOT_RECURRING };

interface RecurringData {
  ruleId: string;
  /** The slot, a local wall-clock stamp: the same time on a clock keeps one key whatever the zone. */
  dueAt: string;
}

/** The task the rule made last, while it is still open: not Done (so not closed either) and not archived. */
const openTaskOf = (services: Services, rule: RecurringRule): TaskSummary | null => {
  if (!rule.lastTaskId) return null;
  try {
    const task = services.tasks.summary(rule.lastTaskId);
    return task.archivedAt === null && task.status !== "done" ? task : null;
  } catch {
    return null;
  }
};

/**
 * Makes a task from a template on a schedule, per project, with no agent: weekly dependency bumps, an audit, a
 * docs check. The rules are in `autopilot_recurring` (edited in the project's settings); this automation's own
 * switch decides whether any of a project's rules run.
 *
 * Each slot has its own dedupe key. A rule that was due while the board was off gets one task for the latest slot,
 * not one per missed slot. A slot that finds the rule's last task still open is skipped (and logged), so a chore
 * nobody has done doesn't pile up.
 */
export const recurring = defineAutomation({
  key: AUTOPILOT_RECURRING,
  title: "Recurring tasks",
  description: "Creates a task from a template on a schedule, such as a weekly dependency bump or audit.",
  needsAgent: false,
  // Its candidates are per project, with no task, so no epic can hold one.
  epicScope: false,
  schema: z.object({}),
  fields: [],
  defaults: {},
  check: ({ services, projects, now }) =>
    projects.flatMap(({ project }): Candidate[] =>
      services.recurring.list(project.id).flatMap((rule): Candidate[] => {
        if (!rule.enabled) return [];
        const due = latestDue(rule.schedule, now, rule.lastDueAt);
        if (!due) return [];
        const dueAt = localStamp(due);
        const open = openTaskOf(services, rule);
        return [
          {
            dedupeKey: `recurring:${rule.id}:${dueAt}`,
            summary: open
              ? `skip recurring rule "${rule.name}": #${open.number} is still open`
              : `create a task from recurring rule "${rule.name}"`,
            projectId: project.id,
            data: { ruleId: rule.id, dueAt } satisfies RecurringData,
          },
        ];
      }),
    ),
  act: (candidate, { services, actor }) => {
    const { ruleId, dueAt } = candidate.data as RecurringData;
    let rule: RecurringRule;
    try {
      rule = services.recurring.get(ruleId);
    } catch {
      return { status: "skipped", summary: "The recurring rule was deleted" };
    }
    // The slot is dealt with whatever happens next, so a failure doesn't leave it pending.
    try {
      const open = openTaskOf(services, rule);
      if (open) {
        services.recurring.handled(rule.id, { dueAt });
        return { status: "skipped", summary: `Skipped "${rule.name}": #${open.number} is still open` };
      }
      if (!rule.templateId) throw new Error(`The template of "${rule.name}" was deleted; pick another one`);
      const template = services.templates.get(rule.templateId);
      const task = services.tasks.create({
        projectId: rule.projectId,
        template: template.id,
        // A template's plan is copied either way; Planned is where a task with a plan belongs.
        status: templateHasPlan(template) ? "planned" : "backlog",
        ...(rule.flagAutopilot ? { autopilot: true } : {}),
        actor,
      });
      services.tasks.addNote(task.id, `Created by Autopilot from recurring rule ${rule.name}`, actor);
      services.recurring.handled(rule.id, { dueAt, taskId: task.id });
      return { summary: `Created #${task.number} from "${rule.name}"` };
    } catch (error) {
      services.recurring.handled(rule.id, { dueAt });
      throw error;
    }
  },
});
