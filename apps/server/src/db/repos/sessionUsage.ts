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
