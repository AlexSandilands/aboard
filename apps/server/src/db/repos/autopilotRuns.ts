import type { AutopilotRun, AutopilotRunStatus } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

interface RunRow {
  id: string;
  automation: string;
  task_id: string | null;
  project_id: string | null;
  dedupe_key: string;
  status: AutopilotRunStatus;
  summary: string;
  dry_run: number;
  runner: string | null;
  session_id: string | null;
  thread_url: string | null;
  worktree_path: string | null;
  cost_usd: number | null;
  error: string | null;
  needs_attention: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

const toRun = (r: RunRow): AutopilotRun => ({
  id: r.id,
  automation: r.automation,
  taskId: r.task_id,
  projectId: r.project_id,
  dedupeKey: r.dedupe_key,
  status: r.status,
  summary: r.summary,
  dryRun: r.dry_run === 1,
  runner: r.runner,
  sessionId: r.session_id,
  threadUrl: r.thread_url,
  worktreePath: r.worktree_path,
  costUsd: r.cost_usd,
  error: r.error,
  needsAttention: r.needs_attention === 1,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  updatedAt: r.updated_at,
});

const toRow = (r: AutopilotRun) => ({
  id: r.id,
  automation: r.automation,
  task_id: r.taskId,
  project_id: r.projectId,
  dedupe_key: r.dedupeKey,
  status: r.status,
  summary: r.summary,
  dry_run: r.dryRun ? 1 : 0,
  runner: r.runner,
  session_id: r.sessionId,
  thread_url: r.threadUrl,
  worktree_path: r.worktreePath,
  cost_usd: r.costUsd,
  error: r.error,
  needs_attention: r.needsAttention ? 1 : 0,
  created_at: r.createdAt,
  started_at: r.startedAt,
  finished_at: r.finishedAt,
  updated_at: r.updatedAt,
});

/** Typed access to autopilot_runs, the engine's history. */
export function createAutopilotRunsRepo(sql: Sql) {
  return {
    get(id: string): AutopilotRun | null {
      const row = sql.get<RunRow>("SELECT * FROM autopilot_runs WHERE id = ?", id);
      return row ? toRun(row) : null;
    },
    insert(run: AutopilotRun): void {
      sql.insert("autopilot_runs", toRow(run));
    },
    update(run: AutopilotRun): void {
      sql.update("autopilot_runs", toRow(run));
    },
    /** Whether the automation already has a run (real or dry-run, as asked) for this dedupe key. */
    exists(automation: string, dedupeKey: string, dryRun: boolean): boolean {
      return (
        sql.get(
          "SELECT 1 FROM autopilot_runs WHERE automation = ? AND dedupe_key = ? AND dry_run = ?",
          automation,
          dedupeKey,
          dryRun ? 1 : 0,
        ) !== undefined
      );
    },
    /** Newest first. */
    forTask(taskId: string, limit: number): AutopilotRun[] {
      return sql
        .all<RunRow>(
          "SELECT * FROM autopilot_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          taskId,
          limit,
        )
        .map(toRun);
    },
    /** Newest first. */
    forProject(projectId: string, limit: number): AutopilotRun[] {
      return sql
        .all<RunRow>(
          "SELECT * FROM autopilot_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          projectId,
          limit,
        )
        .map(toRun);
    },
    /** Oldest first. */
    withStatus(statuses: readonly AutopilotRunStatus[]): AutopilotRun[] {
      return sql
        .all<RunRow>(
          "SELECT * FROM autopilot_runs WHERE status IN (SELECT value FROM json_each(?)) ORDER BY created_at, id",
          jsonList(statuses),
        )
        .map(toRun);
    },
    /** Real runs of these automations that started at or after `since`. */
    startedSince(automations: readonly string[], since: string): number {
      return (
        sql.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM autopilot_runs WHERE dry_run = 0 AND started_at >= ?
           AND automation IN (SELECT value FROM json_each(?))`,
          since,
          jsonList(automations),
        )?.n ?? 0
      );
    },
    /** What real runs created at or after `since` cost, in USD. */
    spendSince(since: string): number {
      return (
        sql.get<{ total: number | null }>(
          "SELECT SUM(cost_usd) AS total FROM autopilot_runs WHERE dry_run = 0 AND created_at >= ?",
          since,
        )?.total ?? 0
      );
    },
    /**
     * Per task, the message of its latest run flagged needs_attention, while it stands: no real run of the same
     * automation on the task has succeeded since, and the task hasn't changed status since.
     */
    attentionFor(taskIds: readonly string[]): Map<string, string> {
      const rows = sql.all<{ task_id: string; message: string }>(
        `SELECT r.task_id, COALESCE(r.error, r.summary) AS message
         FROM autopilot_runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.task_id IN (SELECT value FROM json_each(?)) AND r.needs_attention = 1
           AND r.updated_at >= t.status_changed_at
           AND NOT EXISTS (
             SELECT 1 FROM autopilot_runs s
             WHERE s.task_id = r.task_id AND s.automation = r.automation AND s.status = 'succeeded' AND s.dry_run = 0 AND s.finished_at > r.updated_at
           )
         ORDER BY r.updated_at, r.id`,
        jsonList(taskIds),
      );
      // Ordered oldest first, so the latest flagged run's message wins.
      return new Map(rows.map((r) => [r.task_id, r.message]));
    },
  };
}
