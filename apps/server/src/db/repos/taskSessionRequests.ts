import type { Sql } from "./sql.ts";

/** Orchestrate's request for a new agent session on a task (start_task_session), until Task sessions takes it up. */
export interface TaskSessionRequest {
  id: string;
  taskId: string;
  projectId: string;
  note: string;
  actor: string;
  requestedByRunId: string | null;
  createdAt: string;
  /** The Task sessions run that took it up. */
  runId: string | null;
  droppedAt: string | null;
  droppedReason: string | null;
}

interface Row {
  id: string;
  task_id: string;
  project_id: string;
  note: string;
  actor: string;
  requested_by_run_id: string | null;
  created_at: string;
  run_id: string | null;
  dropped_at: string | null;
  dropped_reason: string | null;
}

const toRequest = (r: Row): TaskSessionRequest => ({
  id: r.id,
  taskId: r.task_id,
  projectId: r.project_id,
  note: r.note,
  actor: r.actor,
  requestedByRunId: r.requested_by_run_id,
  createdAt: r.created_at,
  runId: r.run_id,
  droppedAt: r.dropped_at,
  droppedReason: r.dropped_reason,
});

/** Typed access to task_session_requests. */
export function createTaskSessionRequestsRepo(sql: Sql) {
  return {
    get(id: string): TaskSessionRequest | null {
      const row = sql.get<Row>("SELECT * FROM task_session_requests WHERE id = ?", id);
      return row ? toRequest(row) : null;
    },
    insert(r: Omit<TaskSessionRequest, "runId" | "droppedAt" | "droppedReason">): void {
      sql.insert("task_session_requests", {
        id: r.id,
        task_id: r.taskId,
        project_id: r.projectId,
        note: r.note,
        actor: r.actor,
        requested_by_run_id: r.requestedByRunId,
        created_at: r.createdAt,
      });
    },
    /** Requests made at or after `since` that weren't dropped, taken up or not, oldest first. */
    open(since: string): TaskSessionRequest[] {
      return sql
        .all<Row>(
          "SELECT * FROM task_session_requests WHERE dropped_at IS NULL AND created_at >= ? ORDER BY created_at, id",
          since,
        )
        .map(toRequest);
    },
    /** The task's requests made at or after `since`, newest first, whatever became of them. */
    forTaskSince(taskId: string, since: string): TaskSessionRequest[] {
      return sql
        .all<Row>(
          "SELECT * FROM task_session_requests WHERE task_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC",
          taskId,
          since,
        )
        .map(toRequest);
    },
    /** Marks the request taken up by `runId` (again, for a retried run); false when it was dropped. */
    take(id: string, runId: string): boolean {
      return (
        sql.run("UPDATE task_session_requests SET run_id = ? WHERE id = ? AND dropped_at IS NULL", runId, id).changes >
        0
      );
    },
    /**
     * Drops a request not dropped yet, with the reason; false when it already was. One taken up is only dropped once
     * its run was retried, so no run of it is going.
     */
    drop(id: string, at: string, reason: string): boolean {
      return (
        sql.run(
          "UPDATE task_session_requests SET dropped_at = ?, dropped_reason = ? WHERE id = ? AND dropped_at IS NULL",
          at,
          reason,
          id,
        ).changes > 0
      );
    },
  };
}
