import { RecurringSchedule, type RecurringRule } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface RuleRow {
  id: string;
  project_id: string;
  name: string;
  template_id: string | null;
  schedule_json: string;
  flag_autopilot: number;
  enabled: number;
  last_due_at: string;
  last_task_id: string | null;
  created_at: string;
  updated_at: string;
}

const toRule = (r: RuleRow): RecurringRule => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  templateId: r.template_id,
  // Written through the schema, so it parses; a hand-edited row that doesn't is a corrupt database, not a rule.
  schedule: RecurringSchedule.parse(JSON.parse(r.schedule_json)),
  flagAutopilot: r.flag_autopilot === 1,
  enabled: r.enabled === 1,
  lastDueAt: r.last_due_at,
  lastTaskId: r.last_task_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRow = (r: RecurringRule) => ({
  id: r.id,
  project_id: r.projectId,
  name: r.name,
  template_id: r.templateId,
  schedule_json: JSON.stringify(r.schedule),
  flag_autopilot: r.flagAutopilot ? 1 : 0,
  enabled: r.enabled ? 1 : 0,
  last_due_at: r.lastDueAt,
  last_task_id: r.lastTaskId,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
});

/** Typed access to autopilot_recurring: the recurring-task rules of the Recurring tasks automation. */
export function createAutopilotRecurringRepo(sql: Sql) {
  return {
    get(id: string): RecurringRule | null {
      const row = sql.get<RuleRow>("SELECT * FROM autopilot_recurring WHERE id = ?", id);
      return row ? toRule(row) : null;
    },
    /** Oldest first, so a project's rules keep the order they were made in. */
    forProject(projectId: string): RecurringRule[] {
      return sql
        .all<RuleRow>("SELECT * FROM autopilot_recurring WHERE project_id = ? ORDER BY created_at, id", projectId)
        .map(toRule);
    },
    /** The rule called `name` (any case) in a project. */
    byName(projectId: string, name: string): RecurringRule | null {
      const row = sql.get<RuleRow>(
        "SELECT * FROM autopilot_recurring WHERE project_id = ? AND name = ? COLLATE NOCASE",
        projectId,
        name,
      );
      return row ? toRule(row) : null;
    },
    insert(rule: RecurringRule): void {
      sql.insert("autopilot_recurring", toRow(rule));
    },
    update(rule: RecurringRule): void {
      sql.update("autopilot_recurring", toRow(rule));
    },
    delete(id: string): void {
      sql.run("DELETE FROM autopilot_recurring WHERE id = ?", id);
    },
  };
}
