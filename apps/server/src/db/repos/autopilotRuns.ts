import type { SQLInputValue } from "node:sqlite";
import {
  AUTOPILOT_ACTOR,
  AUTOPILOT_ALL_RUNS,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_UNSTICK,
  CHECK_FAILED_KEY_PREFIX,
  FIX_GAVE_UP_KEY_PREFIX,
  FIX_RESOLVE_KEY_PREFIX,
  RETRIED_PREFIX,
  type AutopilotRun,
  type AutopilotRunFilter,
  type AutopilotRunStatus,
} from "@repo/contracts";
import { parseJson } from "../database.ts";
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
  detail: string | null;
  exit_code: number | null;
  error: string | null;
  needs_attention: number;
  dismissed_at: string | null;
  output_json: string | null;
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
  detail: r.detail,
  exitCode: r.exit_code,
  error: r.error,
  needsAttention: r.needs_attention === 1,
  dismissedAt: r.dismissed_at,
  output: parseJson<Record<string, unknown>>(r.output_json),
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
  detail: r.detail,
  exit_code: r.exitCode,
  error: r.error,
  needs_attention: r.needsAttention ? 1 : 0,
  dismissed_at: r.dismissedAt,
  output_json: r.output ? JSON.stringify(r.output) : null,
  created_at: r.createdAt,
  started_at: r.startedAt,
  finished_at: r.finishedAt,
  updated_at: r.updatedAt,
});

/** What a hand delete weighs about a run before it goes (see the service's `deleteRuns`). */
export interface RunDeleteFacts {
  id: string;
  automation: string;
  taskId: string | null;
  status: AutopilotRunStatus;
  createdAt: string;
  runner: string | null;
  worktreePath: string | null;
  /** On a task that isn't done or archived. */
  openTask: boolean;
  /** The newest succeeded answer of a scheduled agent in its project: what its next run is handed. */
  latestAnswer: boolean;
}

/** Escapes `%`, `_` and the escape character itself for `LIKE ? ESCAPE '\'`. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

const encodeCursor = (run: Pick<RunRow, "created_at" | "id">): string =>
  Buffer.from(JSON.stringify([run.created_at, run.id])).toString("base64url");

/** The (created_at, id) a cursor stands for; null when it isn't one this repo made. */
function decodeCursor(cursor: string): [string, string] | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string")) {
      return [value[0] as string, value[1] as string];
    }
  } catch {
    // Not base64url or not JSON: the same as any other cursor we didn't make.
  }
  return null;
}

/** The WHERE clause and bindings for a history filter (runs are aliased `r`). */
function filterClause(filter: AutopilotRunFilter): { where: string; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.automation !== AUTOPILOT_ALL_RUNS) {
    where.push("r.automation = ?");
    params.push(filter.automation);
  }
  if (filter.projectId) {
    where.push("r.project_id = ?");
    params.push(filter.projectId);
  }
  // Stored times are always toISOString(), so a filter time is normalized the same way and compares as text.
  if (filter.since) {
    where.push("r.created_at >= ?");
    params.push(new Date(filter.since).toISOString());
  }
  if (filter.until) {
    where.push("r.created_at < ?");
    params.push(new Date(filter.until).toISOString());
  }
  if (filter.q) {
    const like = likePattern(filter.q);
    const taskNumber = /^#(\d+)$/.exec(filter.q);
    where.push(
      `(r.id LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\'
        OR json_extract(r.output_json, '$.summary') LIKE ? ESCAPE '\\'
        OR json_extract(r.output_json, '$.handover') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM projects p WHERE p.id = r.project_id AND p.title LIKE ? ESCAPE '\\')
        ${taskNumber ? "OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = r.task_id AND t.number = ?)" : ""})`,
    );
    params.push(like, like, like, like, like);
    if (taskNumber) params.push(Number(taskNumber[1]));
  }
  return { where: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** Typed access to autopilot_runs, the engine's history. */
export function createAutopilotRunsRepo(sql: Sql) {
  return {
    /**
     * One page of the history page's list: runs matching the filter, newest first, `limit` of them after the cursor.
     * Paged by (created_at, id), so runs made meanwhile don't shift a page. Null cursor means the first page; a cursor
     * this repo didn't make is `invalid`.
     */
    history(
      filter: AutopilotRunFilter,
      cursor: string | undefined,
      limit: number,
    ): { runs: AutopilotRun[]; nextCursor: string | null } | "invalid" {
      const { where, params } = filterClause(filter);
      let after = "";
      if (cursor !== undefined) {
        const at = decodeCursor(cursor);
        if (!at) return "invalid";
        after = `${where ? " AND" : "WHERE"} (r.created_at < ? OR (r.created_at = ? AND r.id < ?))`;
        params.push(at[0], at[0], at[1]);
      }
      const rows = sql.all<RunRow>(
        `SELECT r.* FROM autopilot_runs r ${where}${after} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
        ...params,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      return { runs: page.map(toRun), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
    },
    /** The ids of every run matching the filter. */
    idsMatching(filter: AutopilotRunFilter): string[] {
      const { where, params } = filterClause(filter);
      return sql.all<{ id: string }>(`SELECT r.id FROM autopilot_runs r ${where}`, ...params).map((r) => r.id);
    },
    /** What a hand delete weighs about each of these runs; an id that doesn't exist isn't returned. */
    deleteFacts(ids: readonly string[]): RunDeleteFacts[] {
      return sql
        .all<{
          id: string;
          automation: string;
          task_id: string | null;
          status: AutopilotRunStatus;
          created_at: string;
          runner: string | null;
          worktree_path: string | null;
          open_task: number;
          latest_answer: number;
        }>(
          `SELECT r.id, r.automation, r.task_id, r.status, r.created_at, r.runner, r.worktree_path,
             r.task_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM tasks t WHERE t.id = r.task_id AND t.status <> 'done' AND t.archived_at IS NULL
             ) AS open_task,
             r.id IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (PARTITION BY automation, project_id ORDER BY finished_at DESC, rowid DESC) AS n
                 FROM autopilot_runs
                 WHERE project_id IS NOT NULL AND task_id IS NULL AND dry_run = 0 AND status = 'succeeded'
                   AND json_extract(output_json, '$.kind') = 'scheduled_agent'
               ) WHERE n = 1
             ) AS latest_answer
           FROM autopilot_runs r WHERE r.id IN (SELECT value FROM json_each(?))`,
          jsonList(ids),
        )
        .map((r) => ({
          id: r.id,
          automation: r.automation,
          taskId: r.task_id,
          status: r.status,
          createdAt: r.created_at,
          runner: r.runner,
          worktreePath: r.worktree_path,
          openTask: r.open_task === 1,
          latestAnswer: r.latest_answer === 1,
        }));
    },
    /** Deletes these runs; the caller has already weighed which may go. Returns how many were removed. */
    deleteIds(ids: readonly string[]): number {
      return Number(
        sql.run("DELETE FROM autopilot_runs WHERE id IN (SELECT value FROM json_each(?))", jsonList(ids)).changes,
      );
    },
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
    /**
     * The newest real run of a scheduled agent in a project that succeeded and left an answer: the one whose handover
     * the next run gets. A failed or skipped run leaves no answer to pick, so the one before it still counts.
     */
    lastScheduledAnswer(automation: string, projectId: string): AutopilotRun | null {
      const row = sql.get<RunRow>(
        `SELECT * FROM autopilot_runs WHERE automation = ? AND project_id = ? AND task_id IS NULL AND dry_run = 0
         AND status = 'succeeded' AND json_extract(output_json, '$.kind') = 'scheduled_agent'
         ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
        automation,
        projectId,
      );
      return row ? toRun(row) : null;
    },
    /** The run that made this headless session, if any. */
    forSession(sessionId: string): AutopilotRun | null {
      const row = sql.get<RunRow>(
        "SELECT * FROM autopilot_runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        sessionId,
      );
      return row ? toRun(row) : null;
    },
    /** Newest first. */
    // Newest first; rowid breaks a tie in created_at (runs made in one millisecond), which a random id can't.
    forTask(taskId: string, limit: number): AutopilotRun[] {
      return sql
        .all<RunRow>(
          "SELECT * FROM autopilot_runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          taskId,
          limit,
        )
        .map(toRun);
    },
    /** Newest first. */
    forProject(projectId: string, limit: number): AutopilotRun[] {
      return sql
        .all<RunRow>(
          "SELECT * FROM autopilot_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          projectId,
          limit,
        )
        .map(toRun);
    },
    /** One automation's runs in a project, newest first. */
    forProjectAutomation(projectId: string, automation: string, limit: number): AutopilotRun[] {
      return sql
        .all<RunRow>(
          "SELECT * FROM autopilot_runs WHERE project_id = ? AND automation = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          projectId,
          automation,
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
    /** Finished headless runs that made a worktree, oldest first: what worktree cleanup looks at. */
    finishedWithWorktree(): AutopilotRun[] {
      return sql
        .all<RunRow>(
          `SELECT * FROM autopilot_runs WHERE runner = 'headless' AND worktree_path IS NOT NULL
           AND finished_at IS NOT NULL ORDER BY finished_at, id`,
        )
        .map(toRun);
    },
    /** Real runs that finished at or after `from` and before `to`, oldest first, leaving out these automations. */
    between(from: string, to: string, except: readonly string[]): AutopilotRun[] {
      return sql
        .all<RunRow>(
          `SELECT * FROM autopilot_runs WHERE dry_run = 0 AND finished_at >= ? AND finished_at < ?
           AND automation NOT IN (SELECT value FROM json_each(?)) ORDER BY finished_at, id`,
          from,
          to,
          jsonList(except),
        )
        .map(toRun);
    },
    /**
     * Real runs of these automations that started at or after `since`, leaving out the ones that start no agent: Fix
     * PRs give-ups and thread resolving, and failed check scripts, retried or not.
     */
    startedSince(automations: readonly string[], since: string): number {
      // A retried run's key is `retried:<id>:<key>`, and an id has no colon.
      const noAgent = [FIX_GAVE_UP_KEY_PREFIX, FIX_RESOLVE_KEY_PREFIX, CHECK_FAILED_KEY_PREFIX].flatMap((prefix) => [
        `${prefix}%`,
        `${RETRIED_PREFIX}%:${prefix}%`,
      ]);
      return (
        sql.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM autopilot_runs WHERE dry_run = 0 AND started_at >= ?
           AND automation IN (SELECT value FROM json_each(?))
           ${noAgent.map(() => "AND dedupe_key NOT LIKE ?").join(" ")}`,
          since,
          jsonList(automations),
          ...noAgent,
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
    /** When the task's latest run flagged needs_attention (and not dismissed) was last written, if it has one. */
    latestFlaggedAt(taskId: string): string | null {
      return (
        sql.get<{ at: string | null }>(
          "SELECT MAX(updated_at) AS at FROM autopilot_runs WHERE task_id = ? AND needs_attention = 1 AND dismissed_at IS NULL",
          taskId,
        )?.at ?? null
      );
    },
    /**
     * Marks every flagged run of the task as dismissed, so none of them stands any more: an older flagged run must
     * not resurface once the latest is dismissed. The runs themselves stay as they were.
     */
    dismissFlagged(taskId: string, at: string): void {
      sql.run(
        "UPDATE autopilot_runs SET dismissed_at = ? WHERE task_id = ? AND needs_attention = 1 AND dismissed_at IS NULL",
        at,
        taskId,
      );
    },
    /**
     * Per task, when its newest clean Autopilot PR review started: a real, succeeded Review PRs run whose verdict
     * handed off as "clean" and raised nothing blocking or major. The local review counts it as the re-review of
     * fixes made at the round limit. The start, not the finish, is what says the review saw the fixes: one that
     * began before they were resolved may have read the old head. The hand-off alone isn't enough, because a
     * high fix threshold lets a review with major issues hand off clean, and the local gate is blocking and major.
     */
    cleanPrReviewTimes(taskIds: readonly string[]): Map<string, string> {
      const rows = sql.all<{ task_id: string; at: string }>(
        `SELECT task_id, MAX(COALESCE(started_at, finished_at)) AS at FROM autopilot_runs
         WHERE task_id IN (SELECT value FROM json_each(?)) AND automation = ? AND status = 'succeeded' AND dry_run = 0
           AND COALESCE(started_at, finished_at) IS NOT NULL AND json_extract(output_json, '$.kind') = 'pr_review'
           AND json_extract(output_json, '$.handoff') = 'clean'
           AND COALESCE(json_extract(output_json, '$.counts.blocking'), 0)
             + COALESCE(json_extract(output_json, '$.counts.major'), 0) = 0
         GROUP BY task_id`,
        jsonList(taskIds),
        AUTOPILOT_REVIEW_PRS,
      );
      return new Map(rows.map((r) => [r.task_id, r.at]));
    },
    /**
     * Per task, the message of its latest run flagged needs_attention, while it stands: the user hasn't dismissed it,
     * no real run of the same automation on the task has succeeded since, and the task hasn't changed status since.
     * A flagged Unstick run also clears when anyone but Autopilot has logged activity on the task since.
     */
    attentionFor(taskIds: readonly string[]): Map<string, string> {
      const rows = sql.all<{ task_id: string; message: string }>(
        `SELECT r.task_id, COALESCE(r.error, r.summary) AS message
         FROM autopilot_runs r JOIN tasks t ON t.id = r.task_id
         WHERE r.task_id IN (SELECT value FROM json_each(?)) AND r.needs_attention = 1
           AND r.dismissed_at IS NULL AND r.updated_at >= t.status_changed_at
           AND NOT (r.automation = ? AND EXISTS (
             SELECT 1 FROM task_events e WHERE e.task_id = r.task_id AND e.actor <> ? AND e.at > r.updated_at
           ))
           AND NOT EXISTS (
             SELECT 1 FROM autopilot_runs s
             WHERE s.task_id = r.task_id AND s.automation = r.automation AND s.status = 'succeeded' AND s.dry_run = 0 AND s.finished_at > r.updated_at
           )
         ORDER BY r.updated_at, r.id`,
        jsonList(taskIds),
        AUTOPILOT_UNSTICK,
        AUTOPILOT_ACTOR,
      );
      // Ordered oldest first, so the latest flagged run's message wins.
      return new Map(rows.map((r) => [r.task_id, r.message]));
    },
  };
}
