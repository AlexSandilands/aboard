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

/** An activity entry with the task it is about, for reports over a period. */
export interface PeriodEvent extends TaskEvent {
  number: number;
  title: string;
  projectId: string;
}

/** Typed access to the task_events activity log. */
export function createEventsRepo(sql: Sql) {
  /** Latest event of any of these types per task. */
  const latestOfType = (taskIds: readonly string[], types: readonly string[]): TaskEvent[] =>
    sql
      .all<EventRow>(
        `SELECT * FROM task_events WHERE id IN (
           SELECT MAX(id) FROM task_events
           WHERE type IN (SELECT value FROM json_each(?)) AND task_id IN (SELECT value FROM json_each(?))
           GROUP BY task_id)`,
        jsonList(types),
        jsonList(taskIds),
      )
      .map(toEvent);

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
    /** How many links of a kind were ever added to a task, removed ones included. */
    linksAdded(taskId: string, kind: string): number {
      return (
        sql.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND type = 'link_added' AND json_extract(payload_json, '$.kind') = ?",
          taskId,
          kind,
        )?.n ?? 0
      );
    },
    /** The most recent `limit` events for a task, oldest first. */
    recent(taskId: string, limit: number): TaskEvent[] {
      return sql
        .all<EventRow>("SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?", taskId, limit)
        .map(toEvent)
        .reverse();
    },
    /** Events of these types at or after `from` and before `to`, oldest first, with their task's number, title and project. */
    between(types: readonly string[], from: string, to: string): PeriodEvent[] {
      return sql
        .all<EventRow & { number: number; title: string; project_id: string }>(
          `SELECT e.*, t.number, t.title, t.project_id FROM task_events e JOIN tasks t ON t.id = e.task_id
           WHERE e.at >= ? AND e.at < ? AND e.type IN (SELECT value FROM json_each(?)) ORDER BY e.id`,
          from,
          to,
          jsonList(types),
        )
        .map((r) => ({ ...toEvent(r), number: r.number, title: r.title, projectId: r.project_id }));
    },
    /** Events of these types on these tasks, oldest first. */
    ofTypes(taskIds: readonly string[], types: readonly string[]): TaskEvent[] {
      return sql
        .all<EventRow>(
          `SELECT * FROM task_events
           WHERE task_id IN (SELECT value FROM json_each(?)) AND type IN (SELECT value FROM json_each(?)) ORDER BY id`,
          jsonList(taskIds),
          jsonList(types),
        )
        .map(toEvent);
    },
    /** Latest "note" event per task. */
    lastNotes(taskIds: readonly string[]): TaskEvent[] {
      return latestOfType(taskIds, ["note"]);
    },
    latestOfType,
  };
}
