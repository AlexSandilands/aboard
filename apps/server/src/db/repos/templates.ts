import type { ModelTier, TaskTemplate, TemplatePhase } from "@repo/contracts";
import { parseJson } from "../database.ts";
import type { Sql } from "./sql.ts";

interface TemplateRow {
  id: string;
  name: string;
  project_id: string | null;
  title_pattern: string;
  description: string | null;
  labels_json: string;
  plan_context: string | null;
  phases_json: string;
  suggested_tier: ModelTier | null;
  created_at: string;
  updated_at: string;
}

const toTemplate = (r: TemplateRow): TaskTemplate => ({
  id: r.id,
  name: r.name,
  projectId: r.project_id,
  titlePattern: r.title_pattern,
  description: r.description,
  labels: parseJson<string[]>(r.labels_json) ?? [],
  planContext: r.plan_context,
  phases: parseJson<TemplatePhase[]>(r.phases_json) ?? [],
  suggestedTier: r.suggested_tier,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRow = (t: TaskTemplate): TemplateRow => ({
  id: t.id,
  name: t.name,
  project_id: t.projectId,
  title_pattern: t.titlePattern,
  description: t.description,
  labels_json: JSON.stringify(t.labels),
  plan_context: t.planContext,
  phases_json: JSON.stringify(t.phases),
  suggested_tier: t.suggestedTier,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
});

/** Typed access to the task_templates table. */
export function createTemplatesRepo(sql: Sql) {
  return {
    get(id: string): TaskTemplate | null {
      const row = sql.get<TemplateRow>("SELECT * FROM task_templates WHERE id = ?", id);
      return row ? toTemplate(row) : null;
    },
    /** Board-wide templates first, then each project's, each group by name. */
    list(): TaskTemplate[] {
      return sql
        .all<TemplateRow>(
          "SELECT * FROM task_templates ORDER BY project_id IS NOT NULL, project_id, name COLLATE NOCASE, id",
        )
        .map(toTemplate);
    },
    /** The template called `name` (any case) in one scope: a project's, or the board-wide ones when null. */
    byName(name: string, projectId: string | null): TaskTemplate | null {
      const row = sql.get<TemplateRow>(
        "SELECT * FROM task_templates WHERE name = ? COLLATE NOCASE AND project_id IS ?",
        name,
        projectId,
      );
      return row ? toTemplate(row) : null;
    },
    insert(t: TaskTemplate): void {
      sql.insert("task_templates", { ...toRow(t) });
    },
    update(t: TaskTemplate): void {
      sql.update("task_templates", { ...toRow(t) });
    },
    delete(id: string): void {
      sql.run("DELETE FROM task_templates WHERE id = ?", id);
    },
  };
}
