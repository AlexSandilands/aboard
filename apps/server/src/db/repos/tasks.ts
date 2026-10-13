import type { TaskStatus } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

/** A tasks row in domain shape. */
export interface TaskRecord {
  id: string;
  number: number;
  projectId: string;
  title: string;
  description: string | null;
  planContext: string | null;
  status: TaskStatus;
  position: string;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
}

interface TaskRow {
  id: string;
  number: number;
  project_id: string;
  title: string;
  description: string | null;
  plan_context: string | null;
  status: TaskStatus;
  position: string;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
}

const toRecord = (r: TaskRow): TaskRecord => ({
  id: r.id,
  number: r.number,
  projectId: r.project_id,
  title: r.title,
  description: r.description,
  planContext: r.plan_context,
  status: r.status,
  position: r.position,
  archivedAt: r.archived_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  statusChangedAt: r.status_changed_at,
});

const toRow = (t: TaskRecord): TaskRow => ({
  id: t.id,
  number: t.number,
  project_id: t.projectId,
  title: t.title,
  description: t.description,
  plan_context: t.planContext,
  status: t.status,
  position: t.position,
  archived_at: t.archivedAt,
  created_by: t.createdBy,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
  status_changed_at: t.statusChangedAt,
});

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus;
  includeArchived?: boolean;
}

/** Typed access to the tasks table. */
export function createTasksRepo(sql: Sql) {
  return {
    get(id: string): TaskRecord | null {
      const row = sql.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },
    byNumber(n: number): TaskRecord | null {
      const row = sql.get<TaskRow>("SELECT * FROM tasks WHERE number = ?", n);
      return row ? toRecord(row) : null;
    },
    getMany(ids: readonly string[]): TaskRecord[] {
      return sql
        .all<TaskRow>("SELECT * FROM tasks WHERE id IN (SELECT value FROM json_each(?))", jsonList(ids))
        .map(toRecord);
    },
    /** Tasks ordered by project lane order, then status and position. */
    list(filter: TaskFilter = {}): TaskRecord[] {
      const where: string[] = [];
      const params: string[] = [];
      if (!filter.includeArchived) where.push("t.archived_at IS NULL");
      if (filter.projectId) {
        where.push("t.project_id = ?");
        params.push(filter.projectId);
      }
      if (filter.status) {
        where.push("t.status = ?");
        params.push(filter.status);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return sql
        .all<TaskRow>(
          `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id ${clause}
           ORDER BY p.position, t.project_id, t.status, t.position, t.id`,
          ...params,
        )
        .map(toRecord);
    },
    idsForProject(projectId: string): string[] {
      return sql.all<{ id: string }>("SELECT id FROM tasks WHERE project_id = ?", projectId).map((r) => r.id);
    },
    /** Non-archived tasks in one column, by position. */
    lane(projectId: string, status: TaskStatus): TaskRecord[] {
      return sql
        .all<TaskRow>(
          "SELECT * FROM tasks WHERE project_id = ? AND status = ? AND archived_at IS NULL ORDER BY position, id",
          projectId,
          status,
        )
        .map(toRecord);
    },
    nextNumber(): number {
      return (sql.get<{ n: number | null }>("SELECT MAX(number) AS n FROM tasks")?.n ?? 0) + 1;
    },
    insert(t: TaskRecord): void {
      sql.insert("tasks", { ...toRow(t) });
    },
    update(t: TaskRecord): void {
      sql.update("tasks", { ...toRow(t) });
    },
  };
}
