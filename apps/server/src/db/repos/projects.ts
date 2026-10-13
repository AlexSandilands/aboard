import type { Project, ProjectIcon } from "@taskboard/contracts";
import { parseJson } from "../database.ts";
import type { Sql } from "./sql.ts";

interface ProjectRow {
  id: string;
  title: string;
  workspace_root: string | null;
  workspace_key: string | null;
  icon_json: string | null;
  t3_project_id: string | null;
  position: string;
  collapsed: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  title: r.title,
  workspaceRoot: r.workspace_root,
  workspaceKey: r.workspace_key,
  icon: parseJson<ProjectIcon>(r.icon_json),
  t3ProjectId: r.t3_project_id,
  position: r.position,
  collapsed: Number(r.collapsed) !== 0,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRow = (p: Project): ProjectRow => ({
  id: p.id,
  title: p.title,
  workspace_root: p.workspaceRoot,
  workspace_key: p.workspaceKey,
  icon_json: p.icon ? JSON.stringify(p.icon) : null,
  t3_project_id: p.t3ProjectId,
  position: p.position,
  collapsed: p.collapsed ? 1 : 0,
  archived_at: p.archivedAt,
  created_at: p.createdAt,
  updated_at: p.updatedAt,
});

/** Typed access to the projects table. */
export function createProjectsRepo(sql: Sql) {
  return {
    list(includeArchived = false): Project[] {
      const where = includeArchived ? "" : "WHERE archived_at IS NULL";
      return sql.all<ProjectRow>(`SELECT * FROM projects ${where} ORDER BY position, id`).map(toProject);
    },
    get(id: string): Project | null {
      const row = sql.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
      return row ? toProject(row) : null;
    },
    byKey(key: string): Project | null {
      const row = sql.get<ProjectRow>("SELECT * FROM projects WHERE workspace_key = ?", key);
      return row ? toProject(row) : null;
    },
    withWorkspace(): Project[] {
      return sql.all<ProjectRow>("SELECT * FROM projects WHERE workspace_key IS NOT NULL").map(toProject);
    },
    lastPosition(): string | null {
      return sql.get<{ p: string | null }>("SELECT MAX(position) AS p FROM projects")?.p ?? null;
    },
    insert(p: Project): void {
      sql.insert("projects", { ...toRow(p) });
    },
    update(p: Project): void {
      sql.update("projects", { ...toRow(p) });
    },
    delete(id: string): void {
      sql.run("DELETE FROM projects WHERE id = ?", id);
    },
  };
}
export type ProjectsRepo = ReturnType<typeof createProjectsRepo>;
