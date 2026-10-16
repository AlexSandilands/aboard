import type { ImportStatus } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

export type ImportSourceKind = "jira" | "issue";

/** A task_imports row in domain shape. */
export interface ImportRecord {
  taskId: string;
  sourceUrl: string;
  sourceKind: ImportSourceKind;
  status: ImportStatus;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

interface ImportRow {
  task_id: string;
  source_url: string;
  source_kind: ImportSourceKind;
  status: ImportStatus;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

const toImport = (r: ImportRow): ImportRecord => ({
  taskId: r.task_id,
  sourceUrl: r.source_url,
  sourceKind: r.source_kind,
  status: r.status,
  error: r.error,
  attempts: r.attempts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Typed access to task_imports. */
export function createImportsRepo(sql: Sql) {
  return {
    get(taskId: string): ImportRecord | null {
      const row = sql.get<ImportRow>("SELECT * FROM task_imports WHERE task_id = ?", taskId);
      return row ? toImport(row) : null;
    },
    forTasks(taskIds: readonly string[]): Map<string, ImportRecord> {
      const rows = sql.all<ImportRow>(
        "SELECT * FROM task_imports WHERE task_id IN (SELECT value FROM json_each(?))",
        jsonList(taskIds),
      );
      return new Map(rows.map((r) => [r.task_id, toImport(r)]));
    },
    /** Imports in a status on non-archived tasks, oldest first. */
    withStatus(status: ImportStatus): ImportRecord[] {
      return sql
        .all<ImportRow>(
          `SELECT i.* FROM task_imports i JOIN tasks t ON t.id = i.task_id
           WHERE i.status = ? AND t.archived_at IS NULL ORDER BY i.created_at, i.task_id`,
          status,
        )
        .map(toImport);
    },
    insert(r: ImportRecord): void {
      sql.insert("task_imports", {
        task_id: r.taskId,
        source_url: r.sourceUrl,
        source_kind: r.sourceKind,
        status: r.status,
        error: r.error,
        attempts: r.attempts,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      });
    },
    update(r: ImportRecord): void {
      sql.run(
        "UPDATE task_imports SET status = ?, error = ?, attempts = ?, updated_at = ? WHERE task_id = ?",
        r.status,
        r.error,
        r.attempts,
        r.updatedAt,
        r.taskId,
      );
    },
  };
}
