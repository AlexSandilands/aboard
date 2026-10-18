import type {
  AttentionRequest,
  EpicDelivery,
  ModelTier,
  SuggestedModel,
  TaskKind,
  TaskResolution,
  TaskStatus,
} from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

/** A tasks row in domain shape. */
export interface TaskRecord {
  id: string;
  number: number;
  projectId: string;
  kind: TaskKind;
  /** The epic this task belongs to. */
  parentId: string | null;
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
  resolution: TaskResolution | null;
  resolvedByTaskId: string | null;
  /** null inherits the global auto-review setting. */
  autoReview: boolean | null;
  /** Autopilot flag: null is Default, which never auto-starts the task. */
  autopilot: boolean | null;
  /** Auto-merge flag: null is Default, which, like false, never lets merge_task_pr merge the task's PR. */
  autoMerge: boolean | null;
  /** Shows in the priority lane above every project. */
  priority: boolean;
  /** An agent's standing request for the user's attention; null when none. */
  attentionRequest: AttentionRequest | null;
  suggestedModel: SuggestedModel | null;
  /** The template it was created from; null for none, or once that template is deleted. */
  templateId: string | null;
  /** An epic's delivery; null until someone chooses one (which delivers to main). */
  delivery: EpicDelivery | null;
  /** An epic's integration branch while it uses integration delivery. */
  integrationBranch: string | null;
}

interface TaskRow {
  id: string;
  number: number;
  project_id: string;
  kind: TaskKind;
  parent_id: string | null;
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
  resolution: TaskResolution | null;
  resolved_by_task_id: string | null;
  auto_review: number | null;
  autopilot: number | null;
  auto_merge: number | null;
  priority: number;
  attention_message: string | null;
  attention_actor: string | null;
  attention_requested_at: string | null;
  suggested_tier: ModelTier | null;
  suggested_reason: string | null;
  template_id: string | null;
  delivery: EpicDelivery | null;
  integration_branch: string | null;
}

const toRecord = (r: TaskRow): TaskRecord => ({
  id: r.id,
  number: r.number,
  projectId: r.project_id,
  kind: r.kind,
  parentId: r.parent_id,
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
  resolution: r.resolution,
  resolvedByTaskId: r.resolved_by_task_id,
  autoReview: r.auto_review === null ? null : r.auto_review !== 0,
  autopilot: r.autopilot === null ? null : r.autopilot !== 0,
  autoMerge: r.auto_merge === null ? null : r.auto_merge !== 0,
  priority: r.priority !== 0,
  attentionRequest:
    r.attention_message !== null && r.attention_actor !== null && r.attention_requested_at !== null
      ? { message: r.attention_message, actor: r.attention_actor, requestedAt: r.attention_requested_at }
      : null,
  suggestedModel: r.suggested_tier ? { tier: r.suggested_tier, reason: r.suggested_reason } : null,
  templateId: r.template_id,
  delivery: r.delivery,
  integrationBranch: r.integration_branch,
});

const toRow = (t: TaskRecord): TaskRow => ({
  id: t.id,
  number: t.number,
  project_id: t.projectId,
  kind: t.kind,
  parent_id: t.parentId,
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
  resolution: t.resolution,
  resolved_by_task_id: t.resolvedByTaskId,
  auto_review: t.autoReview === null ? null : t.autoReview ? 1 : 0,
  autopilot: t.autopilot === null ? null : t.autopilot ? 1 : 0,
  auto_merge: t.autoMerge === null ? null : t.autoMerge ? 1 : 0,
  priority: t.priority ? 1 : 0,
  attention_message: t.attentionRequest?.message ?? null,
  attention_actor: t.attentionRequest?.actor ?? null,
  attention_requested_at: t.attentionRequest?.requestedAt ?? null,
  suggested_tier: t.suggestedModel?.tier ?? null,
  suggested_reason: t.suggestedModel?.reason ?? null,
  template_id: t.templateId,
  delivery: t.delivery,
  integration_branch: t.integrationBranch,
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
    /** Tasks closed against any of `ids` (done by / duplicate of), by number. */
    resolvedBy(ids: readonly string[]): TaskRecord[] {
      return sql
        .all<TaskRow>(
          "SELECT * FROM tasks WHERE resolved_by_task_id IN (SELECT value FROM json_each(?)) ORDER BY number",
          jsonList(ids),
        )
        .map(toRecord);
    },
    /** Children of any of `epicIds`, archived ones included, in lane order (status, then position). */
    childrenOf(epicIds: readonly string[]): TaskRecord[] {
      return sql
        .all<TaskRow>(
          `SELECT * FROM tasks WHERE parent_id IN (SELECT value FROM json_each(?))
           ORDER BY CASE status WHEN 'backlog' THEN 0 WHEN 'planned' THEN 1 WHEN 'in_progress' THEN 2
             WHEN 'review' THEN 3 ELSE 4 END, position, id`,
          jsonList(epicIds),
        )
        .map(toRecord);
    },
    /** Claims the next task number. Call inside the write that inserts the task, so a rollback releases it. */
    nextNumber(): number {
      return sql.get<{ value: number }>(
        "UPDATE counters SET value = value + 1 WHERE name = 'task_number' RETURNING value",
      )!.value;
    },
    insert(t: TaskRecord): void {
      sql.insert("tasks", { ...toRow(t) });
    },
    update(t: TaskRecord): void {
      sql.update("tasks", { ...toRow(t) });
    },
    /** Hard delete; events, plan and links cascade, and tasks closed against it lose the pointer (SET NULL). */
    delete(id: string): void {
      sql.run("DELETE FROM tasks WHERE id = ?", id);
    },
  };
}
