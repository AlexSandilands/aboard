import type { TaskAttachment } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface AttachmentRow {
  id: string;
  task_id: string | null;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
}

const toAttachment = (r: AttachmentRow): TaskAttachment => ({
  id: r.id,
  taskId: r.task_id,
  filename: r.filename,
  mime: r.mime,
  size: r.size,
  createdAt: r.created_at,
});

/** Typed access to task_attachments. */
export function createAttachmentsRepo(sql: Sql) {
  return {
    get(id: string): TaskAttachment | null {
      const row = sql.get<AttachmentRow>("SELECT * FROM task_attachments WHERE id = ?", id);
      return row ? toAttachment(row) : null;
    },
    forTask(taskId: string): TaskAttachment[] {
      // Uploads in the same millisecond keep the order they came in, not their random ids'.
      return sql
        .all<AttachmentRow>("SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at, rowid", taskId)
        .map(toAttachment);
    },
    /** Attachments uploaded for no task yet, created before `before`. */
    orphansBefore(before: string): TaskAttachment[] {
      return sql
        .all<AttachmentRow>(
          "SELECT * FROM task_attachments WHERE task_id IS NULL AND created_at < ? ORDER BY created_at, rowid",
          before,
        )
        .map(toAttachment);
    },
    insert(a: TaskAttachment): void {
      sql.insert("task_attachments", {
        id: a.id,
        task_id: a.taskId,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        created_at: a.createdAt,
      });
    },
    setTask(id: string, taskId: string): void {
      sql.run("UPDATE task_attachments SET task_id = ? WHERE id = ?", taskId, id);
    },
    delete(id: string): void {
      sql.run("DELETE FROM task_attachments WHERE id = ?", id);
    },
  };
}
