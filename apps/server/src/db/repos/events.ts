import type { TaskEvent } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

interface EventRow {
  id: number;
  task_id: string;
  at: string;
  actor: string;
  type: string;
  payload_json: string;
}

const toEvent = (r: EventRow): TaskEvent => ({
  id: r.id,
  taskId: r.task_id,
  at: r.at,
  actor: r.actor,
  type: r.type,
  payload: JSON.parse(r.payload_json || "{}") as Record<string, unknown>,
});

/** Typed access to the task_events activity log. */
export function createEventsRepo(sql: Sql) {
  return {
    append(taskId: string, at: string, actor: string, type: string, payload: Record<string, unknown> = {}): TaskEvent {
      const result = sql.run(
        "INSERT INTO task_events (task_id, at, actor, type, payload_json) VALUES (?, ?, ?, ?, ?)",
        taskId,
        at,
        actor,
        type,
        JSON.stringify(payload),
      );
      return { id: Number(result.lastInsertRowid), taskId, at, actor, type, payload };
    },
    /** The most recent `limit` events for a task, oldest first. */
    recent(taskId: string, limit: number): TaskEvent[] {
      return sql
        .all<EventRow>("SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?", taskId, limit)
        .map(toEvent)
        .reverse();
    },
    /** Latest "note" event per task. */
    lastNotes(taskIds: readonly string[]): TaskEvent[] {
      return sql
        .all<EventRow>(
          `SELECT * FROM task_events WHERE id IN (
             SELECT MAX(id) FROM task_events
             WHERE type = 'note' AND task_id IN (SELECT value FROM json_each(?))
             GROUP BY task_id)`,
          jsonList(taskIds),
        )
        .map(toEvent);
    },
  };
}
