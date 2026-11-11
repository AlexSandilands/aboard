import type { TokenUsage, UsageHarness, UsageSource } from "@repo/contracts";
import type { Sql } from "./sql.ts";

/** One stored bucket: a session's tokens from one file, on one local day, for one model. */
export interface UsageRow {
  harness: UsageHarness;
  sessionId: string;
  /** Relative to the session; '' when not read from a file. */
  sourceFile: string;
  /** YYYY-MM-DD, local. */
  day: string;
  /** '' when the source didn't say. */
  model: string;
  source: UsageSource;
  taskId: string | null;
  purpose: string | null;
  tokens: TokenUsage;
  reportedCostUsd: number | null;
}

export interface UsageCursor {
  offset: number;
  size: number;
  state: unknown;
}

export interface SessionKey {
  harness: UsageHarness;
  sessionId: string;
}

interface DbRow {
  harness: UsageHarness;
  session_id: string;
  source_file: string;
  day: string;
  model: string;
  source: UsageSource;
  task_id: string | null;
  purpose: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  requests: number | null;
  reported_cost_usd: number | null;
}

const fromDb = (r: DbRow): UsageRow => ({
  harness: r.harness,
  sessionId: r.session_id,
  sourceFile: r.source_file,
  day: r.day,
  model: r.model,
  source: r.source,
  taskId: r.task_id,
  purpose: r.purpose,
  tokens: {
    input: r.input,
    output: r.output,
    cacheRead: r.cache_read,
    cacheWrite5m: r.cache_write_5m,
    cacheWrite1h: r.cache_write_1h,
    ...(r.requests === null ? {} : { requests: r.requests }),
  },
  reportedCostUsd: r.reported_cost_usd,
});

// Every session or thread a live task links, as (harness, session_id) pairs: agent sessions directly, T3 threads
// through the sessions recorded behind them. A trashed task still links its sessions until it is purged.
const LINKED_SESSIONS = `
  SELECT json_extract(l.ref_json, '$.harness') AS harness, lower(json_extract(l.ref_json, '$.sessionId')) AS session_id
    FROM task_links l WHERE l.kind = 'agent_session'
  UNION
  SELECT m.harness, m.session_id FROM task_links l
    JOIN session_usage_thread m ON m.thread_id = json_extract(l.ref_json, '$.threadId')
    WHERE l.kind = 't3_thread'`;

/** Typed access to session_usage, its cursors and the sessions behind T3 threads. */
export function createSessionUsageRepo(sql: Sql) {
  const now = () => new Date().toISOString();
  const add = (row: UsageRow, at: string) => {
    const t = row.tokens;
    sql.run(
      `INSERT INTO session_usage (harness, session_id, source_file, day, model, source, task_id, purpose, input, output,
         cache_read, cache_write_5m, cache_write_1h, requests, reported_cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (harness, session_id, source_file, day, model) DO UPDATE SET
         input = input + excluded.input,
         output = output + excluded.output,
         cache_read = cache_read + excluded.cache_read,
         cache_write_5m = cache_write_5m + excluded.cache_write_5m,
         cache_write_1h = cache_write_1h + excluded.cache_write_1h,
         requests = CASE WHEN excluded.requests IS NULL THEN requests ELSE coalesce(requests, 0) + excluded.requests END,
         reported_cost_usd = CASE WHEN excluded.reported_cost_usd IS NULL THEN reported_cost_usd
                                  ELSE coalesce(reported_cost_usd, 0) + excluded.reported_cost_usd END,
         updated_at = excluded.updated_at`,
      row.harness,
      row.sessionId,
      row.sourceFile,
      row.day,
      row.model,
      row.source,
      row.taskId,
      row.purpose,
      t.input,
      t.output,
      t.cacheRead,
      t.cacheWrite5m,
      t.cacheWrite1h,
      t.requests ?? null,
      row.reportedCostUsd,
      at,
    );
  };

  return {
    /** Adds tokens to their day/model buckets, creating them as needed. */
    add(rows: readonly UsageRow[]): void {
      const at = now();
      for (const row of rows) add(row, at);
    },
    /** Replaces everything read from one source file: for a file that shrank or was replaced, or a full reread. */
    replaceFile(key: SessionKey, sourceFile: string, rows: readonly UsageRow[]): void {
      sql.run(
        "DELETE FROM session_usage WHERE harness = ? AND session_id = ? AND source_file = ?",
        key.harness,
        key.sessionId,
        sourceFile,
      );
      const at = now();
      for (const row of rows) add(row, at);
    },
    /** Drops a session's rows from every source but `keep`, so one session is counted from one source only. */
    deleteOtherSources(key: SessionKey, keep: UsageSource): void {
      sql.run(
        "DELETE FROM session_usage WHERE harness = ? AND session_id = ? AND source <> ?",
        key.harness,
        key.sessionId,
        keep,
      );
    },
    cursor(key: SessionKey, sourceFile: string): UsageCursor | null {
      const row = sql.get<{ offset: number; size: number; state_json: string | null }>(
        "SELECT offset, size, state_json FROM session_usage_cursor WHERE harness = ? AND session_id = ? AND source_file = ?",
        key.harness,
        key.sessionId,
        sourceFile,
      );
      return row
        ? { offset: row.offset, size: row.size, state: row.state_json ? (JSON.parse(row.state_json) as unknown) : null }
        : null;
    },
    setCursor(key: SessionKey, sourceFile: string, cursor: UsageCursor): void {
      sql.run(
        `INSERT INTO session_usage_cursor (harness, session_id, source_file, offset, size, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (harness, session_id, source_file) DO UPDATE SET
           offset = excluded.offset, size = excluded.size, state_json = excluded.state_json, updated_at = excluded.updated_at`,
        key.harness,
        key.sessionId,
        sourceFile,
        cursor.offset,
        cursor.size,
        cursor.state === null || cursor.state === undefined ? null : JSON.stringify(cursor.state),
        now(),
      );
    },
    /** The source files a session has cursors for. */
    cursorFiles(key: SessionKey): string[] {
      return sql
        .all<{ source_file: string }>(
          "SELECT source_file FROM session_usage_cursor WHERE harness = ? AND session_id = ?",
          key.harness,
          key.sessionId,
        )
        .map((r) => r.source_file);
    },
    /** Records the sessions behind a T3 thread, replacing what was recorded before. */
    setThreadSessions(threadId: string, sessions: readonly SessionKey[]): void {
      sql.run("DELETE FROM session_usage_thread WHERE thread_id = ?", threadId);
      for (const s of sessions) {
        sql.run(
          "INSERT OR IGNORE INTO session_usage_thread (thread_id, harness, session_id) VALUES (?, ?, ?)",
          threadId,
          s.harness,
          s.sessionId,
        );
      }
    },
    threadSessions(threadId: string): SessionKey[] {
      return sql
        .all<{ harness: UsageHarness; session_id: string }>(
          "SELECT harness, session_id FROM session_usage_thread WHERE thread_id = ? ORDER BY harness, session_id",
          threadId,
        )
        .map((r) => ({ harness: r.harness, sessionId: r.session_id }));
    },
    /** Every row of these sessions. */
    rowsForSessions(keys: readonly SessionKey[]): UsageRow[] {
      if (keys.length === 0) return [];
      const where = keys.map(() => "(harness = ? AND session_id = ?)").join(" OR ");
      return sql
        .all<DbRow>(
          `SELECT * FROM session_usage WHERE ${where} ORDER BY day, model`,
          ...keys.flatMap((k) => [k.harness, k.sessionId]),
        )
        .map(fromDb);
    },
    /** A task's own board runs (run_output rows that name it). */
    rowsForTask(taskId: string): UsageRow[] {
      return sql.all<DbRow>("SELECT * FROM session_usage WHERE task_id = ? ORDER BY day, model", taskId).map(fromDb);
    },
    /** Rows used on days from `fromDay` up to but not including `toDay`. */
    rowsBetween(fromDay: string, toDay: string): UsageRow[] {
      return sql
        .all<DbRow>("SELECT * FROM session_usage WHERE day >= ? AND day < ? ORDER BY day", fromDay, toDay)
        .map(fromDb);
    },
    /** Live tasks (not in the trash) that link the session, directly or through a T3 thread behind it. */
    tasksForSession(key: SessionKey): Array<{ id: string; number: number }> {
      return sql.all<{ id: string; number: number }>(
        `SELECT DISTINCT t.id, t.number FROM task_links l JOIN tasks t ON t.id = l.task_id
         WHERE t.deleted_at IS NULL AND (
           (l.kind = 'agent_session' AND json_extract(l.ref_json, '$.harness') = ?
              AND lower(json_extract(l.ref_json, '$.sessionId')) = ?)
           OR (l.kind = 't3_thread' AND json_extract(l.ref_json, '$.threadId') IN (
              SELECT thread_id FROM session_usage_thread WHERE harness = ? AND session_id = ?)))
         ORDER BY t.number`,
        key.harness,
        key.sessionId,
        key.harness,
        key.sessionId,
      );
    },
    /** Live tasks that link a T3 thread. */
    tasksForThread(threadId: string): Array<{ id: string; number: number }> {
      return sql.all<{ id: string; number: number }>(
        `SELECT DISTINCT t.id, t.number FROM task_links l JOIN tasks t ON t.id = l.task_id
         WHERE t.deleted_at IS NULL AND l.kind = 't3_thread' AND json_extract(l.ref_json, '$.threadId') = ?
         ORDER BY t.number`,
        threadId,
      );
    },
    /** Every agent session and T3 thread a task links, archived tasks included, trashed ones not. */
    linkedSources(): { sessions: Array<SessionKey & { cwd: string | null }>; threads: string[] } {
      const sessions = sql
        .all<{ harness: UsageHarness; session_id: string; cwd: string | null }>(
          `SELECT json_extract(l.ref_json, '$.harness') AS harness, lower(json_extract(l.ref_json, '$.sessionId')) AS session_id,
                  max(json_extract(l.ref_json, '$.cwd')) AS cwd
           FROM task_links l JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'agent_session' AND t.deleted_at IS NULL GROUP BY 1, 2`,
        )
        .filter((r) => r.harness && r.session_id)
        .map((r) => ({ harness: r.harness, sessionId: r.session_id, cwd: r.cwd }));
      const threads = sql
        .all<{ thread_id: string }>(
          `SELECT DISTINCT json_extract(l.ref_json, '$.threadId') AS thread_id
           FROM task_links l JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 't3_thread' AND t.deleted_at IS NULL AND json_extract(l.ref_json, '$.threadId') IS NOT NULL`,
        )
        .map((r) => r.thread_id);
      return { sessions, threads };
    },
    /**
     * The task each session counts under on the stats page: the live task that linked it first, directly or through a
     * T3 thread behind it (the same rule as agent_sessions_started), and whether that first link was the thread.
     */
    owners(): Map<string, { taskId: string; viaThread: boolean }> {
      const rows = sql.all<{ harness: string; session_id: string; task_id: string; via: string }>(
        `SELECT harness, session_id, task_id, via FROM (
           SELECT json_extract(l.ref_json, '$.harness') AS harness, lower(json_extract(l.ref_json, '$.sessionId')) AS session_id,
                  l.task_id, 'session' AS via, l.created_at AS at, l.id AS link_id
           FROM task_links l JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'agent_session' AND t.deleted_at IS NULL
           UNION ALL
           SELECT m.harness, m.session_id, l.task_id, 'thread', l.created_at, l.id
           FROM task_links l JOIN tasks t ON t.id = l.task_id
           JOIN session_usage_thread m ON m.thread_id = json_extract(l.ref_json, '$.threadId')
           WHERE l.kind = 't3_thread' AND t.deleted_at IS NULL
         ) ORDER BY at, link_id`,
      );
      const owners = new Map<string, { taskId: string; viaThread: boolean }>();
      for (const r of rows) {
        const key = `${r.harness}:${r.session_id}`;
        if (!owners.has(key)) owners.set(key, { taskId: r.task_id, viaThread: r.via === "thread" });
      }
      return owners;
    },
    /** Whether the board has ever recorded the sessions behind a thread. */
    hasThread(threadId: string): boolean {
      return sql.get("SELECT 1 FROM session_usage_thread WHERE thread_id = ? LIMIT 1", threadId) !== undefined;
    },
    /**
     * Deletes what no task links any more: the rows and cursors of sessions no remaining link reaches, and the
     * session lists of threads no task links. Run rows of a purged task go with it (ON DELETE CASCADE); task-less runs
     * stay, as they never belonged to a task.
     */
    deleteUnlinked(): void {
      sql.run(
        `DELETE FROM session_usage_thread WHERE thread_id NOT IN (
           SELECT json_extract(ref_json, '$.threadId') FROM task_links WHERE kind = 't3_thread' AND ref_json IS NOT NULL)`,
      );
      for (const table of ["session_usage", "session_usage_cursor"]) {
        sql.run(
          `DELETE FROM ${table} WHERE ${table === "session_usage" ? "source <> 'run_output' AND " : ""}
             (harness, session_id) NOT IN (SELECT harness, session_id FROM (${LINKED_SESSIONS}))`,
        );
      }
    },
  };
}
