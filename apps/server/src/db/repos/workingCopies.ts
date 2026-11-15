import type { StoredChangeLogEntry } from "@repo/contracts";
import { parseJson } from "../database.ts";
import { jsonList, type Sql } from "./sql.ts";

/** What a task row on a runner is: one it holds for the board, or one a held task only points at. */
export type WorkingCopyRole = "held" | "reference";

export interface WorkingCopyRecord {
  taskId: string;
  role: WorkingCopyRole;
  /** The last activity entry already sent in a log entry. */
  lastEventId: number;
  /** The state last logged, as JSON text. */
  loggedState: string | null;
  createdAt: string;
}

interface CopyRow {
  task_id: string;
  role: WorkingCopyRole;
  last_event_id: number;
  logged_state: string | null;
  created_at: string;
}

interface LogRow {
  id: number;
  version: number;
  kind: string;
  task_id: string;
  at: string;
  payload_json: string;
}

const toCopy = (r: CopyRow): WorkingCopyRecord => ({
  taskId: r.task_id,
  role: r.role,
  lastEventId: r.last_event_id,
  loggedState: r.logged_state,
  createdAt: r.created_at,
});

const toEntry = (r: LogRow): StoredChangeLogEntry => ({
  id: r.id,
  version: r.version,
  kind: r.kind,
  taskId: r.task_id,
  at: r.at,
  payload: parseJson<unknown>(r.payload_json),
});

/** What maps one of a runner's projects to the board's. */
export interface CopiedProjectRecord {
  projectId: string;
  /** The board's id for the project; null for one made on the runner that the board hasn't named. */
  boardId: string | null;
  remote: string | null;
  remoteUrl: string | null;
}

interface ProjectRow {
  project_id: string;
  board_id: string | null;
  remote: string | null;
  remote_url: string | null;
}

const toProject = (r: ProjectRow): CopiedProjectRecord => ({
  projectId: r.project_id,
  boardId: r.board_id,
  remote: r.remote,
  remoteUrl: r.remote_url,
});

/** A board's edit a runner has dealt with. */
export interface AppliedEditRecord {
  id: string;
  applied: boolean;
  error: string | null;
  head: number;
}

/** Typed access to a runner's working copies, its change log and what it knows of its board. */
export function createWorkingCopiesRepo(sql: Sql) {
  return {
    get(taskId: string): WorkingCopyRecord | null {
      const row = sql.get<CopyRow>("SELECT * FROM working_copies WHERE task_id = ?", taskId);
      return row ? toCopy(row) : null;
    },
    forTasks(taskIds: readonly string[]): Map<string, WorkingCopyRecord> {
      const rows = sql.all<CopyRow>(
        "SELECT * FROM working_copies WHERE task_id IN (SELECT value FROM json_each(?))",
        jsonList(taskIds),
      );
      return new Map(rows.map((r) => [r.task_id, toCopy(r)]));
    },
    heldIds(): string[] {
      return sql
        .all<{ task_id: string }>("SELECT task_id FROM working_copies WHERE role = 'held' ORDER BY created_at, task_id")
        .map((r) => r.task_id);
    },
    /** References no held task points at any more: nothing reads them. */
    looseReferences(): string[] {
      return sql
        .all<{ task_id: string }>(
          `SELECT w.task_id FROM working_copies w WHERE w.role = 'reference'
             AND NOT EXISTS (SELECT 1 FROM tasks t JOIN working_copies h ON h.task_id = t.id AND h.role = 'held'
                             WHERE t.parent_id = w.task_id OR t.resolved_by_task_id = w.task_id)
             AND NOT EXISTS (SELECT 1 FROM task_relations r JOIN working_copies h
                               ON h.role = 'held' AND h.task_id IN (r.blocker_id, r.blocked_id)
                             WHERE w.task_id IN (r.blocker_id, r.blocked_id))`,
        )
        .map((r) => r.task_id);
    },
    upsert(copy: WorkingCopyRecord): void {
      sql.run(
        `INSERT INTO working_copies (task_id, role, last_event_id, logged_state, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET role = excluded.role, last_event_id = excluded.last_event_id,
           logged_state = excluded.logged_state`,
        copy.taskId,
        copy.role,
        copy.lastEventId,
        copy.loggedState,
        copy.createdAt,
      );
    },
    delete(taskId: string): void {
      sql.run("DELETE FROM working_copies WHERE task_id = ?", taskId);
    },

    append(entry: Omit<StoredChangeLogEntry, "id">): number {
      const result = sql.run(
        "INSERT INTO change_log (version, kind, task_id, at, payload_json) VALUES (?, ?, ?, ?, ?)",
        entry.version,
        entry.kind,
        entry.taskId,
        entry.at,
        JSON.stringify(entry.payload),
      );
      return Number(result.lastInsertRowid);
    },
    /** Entries after `after`, oldest first, at most `limit`. */
    entriesAfter(after: number, limit: number): StoredChangeLogEntry[] {
      return sql.all<LogRow>("SELECT * FROM change_log WHERE id > ? ORDER BY id LIMIT ?", after, limit).map(toEntry);
    },
    /** The id of the newest entry ever written, kept by SQLite even once the entries are dropped. */
    head(): number {
      return sql.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'")?.seq ?? 0;
    },
    /** Drops what the board has applied. */
    dropThrough(id: number): void {
      sql.run("DELETE FROM change_log WHERE id <= ?", id);
    },

    project(projectId: string): CopiedProjectRecord | null {
      const row = sql.get<ProjectRow>("SELECT * FROM copied_projects WHERE project_id = ?", projectId);
      return row ? toProject(row) : null;
    },
    /** The runner's project for one of the board's, by the board's id for it, else by its repository. */
    projectFor(boardId: string, remote: string | null): CopiedProjectRecord | null {
      const row =
        sql.get<ProjectRow>("SELECT * FROM copied_projects WHERE board_id = ?", boardId) ??
        (remote ? sql.get<ProjectRow>("SELECT * FROM copied_projects WHERE remote = ?", remote) : undefined);
      return row ? toProject(row) : null;
    },
    setProject(record: CopiedProjectRecord): void {
      sql.run(
        `INSERT INTO copied_projects (project_id, board_id, remote, remote_url) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET board_id = excluded.board_id, remote = excluded.remote,
           remote_url = excluded.remote_url`,
        record.projectId,
        record.boardId,
        record.remote,
        record.remoteUrl,
      );
    },

    appliedEdit(id: string): AppliedEditRecord | null {
      const row = sql.get<{ id: string; applied: number; error: string | null; head: number }>(
        "SELECT id, applied, error, head FROM applied_edits WHERE id = ?",
        id,
      );
      return row ? { id: row.id, applied: row.applied !== 0, error: row.error, head: row.head } : null;
    },
    recordEdit(edit: AppliedEditRecord, at: string): void {
      sql.run(
        "INSERT OR REPLACE INTO applied_edits (id, applied, error, head, at) VALUES (?, ?, ?, ?, ?)",
        edit.id,
        edit.applied ? 1 : 0,
        edit.error,
        edit.head,
        at,
      );
    },
    /** Forgets edits the board can no longer send again: those dealt with before `cutoff`. */
    pruneEdits(cutoff: string): void {
      sql.run("DELETE FROM applied_edits WHERE at < ?", cutoff);
    },

    state(key: string): string | null {
      return sql.get<{ value: string }>("SELECT value FROM runner_state WHERE key = ?", key)?.value ?? null;
    },
    setState(key: string, value: string): void {
      sql.run(
        "INSERT INTO runner_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
    },
  };
}
