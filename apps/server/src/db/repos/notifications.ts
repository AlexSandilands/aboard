import type { InboxNotification, NotificationKind } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  task_id: string | null;
  title: string;
  body: string;
  dedupe_key: string;
  created_at: string;
  read_at: string | null;
}

const toNotification = (r: NotificationRow): InboxNotification => ({
  id: r.id,
  kind: r.kind,
  taskId: r.task_id,
  title: r.title,
  body: r.body,
  createdAt: r.created_at,
  readAt: r.read_at,
});

/** Typed access to notifications, the attention inbox. */
export function createNotificationsRepo(sql: Sql) {
  return {
    /** Newest first (rowid breaks ties within a millisecond). `since` leaves out rows old enough to be pruned. */
    list(opts: { since: string; kind?: NotificationKind; limit: number }): InboxNotification[] {
      return sql
        .all<NotificationRow>(
          `SELECT * FROM notifications WHERE created_at >= ? AND (? IS NULL OR kind = ?)
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          opts.since,
          opts.kind ?? null,
          opts.kind ?? null,
          opts.limit,
        )
        .map(toNotification);
    },
    get(id: string): InboxNotification | null {
      const row = sql.get<NotificationRow>("SELECT * FROM notifications WHERE id = ?", id);
      return row ? toNotification(row) : null;
    },
    hasKey(dedupeKey: string): boolean {
      return sql.get("SELECT 1 FROM notifications WHERE dedupe_key = ?", dedupeKey) !== undefined;
    },
    insert(n: InboxNotification, dedupeKey: string): void {
      sql.insert("notifications", {
        id: n.id,
        kind: n.kind,
        task_id: n.taskId,
        title: n.title,
        body: n.body,
        dedupe_key: dedupeKey,
        created_at: n.createdAt,
        read_at: n.readAt,
      });
    },
    unread(since: string): number {
      return (
        sql.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND created_at >= ?",
          since,
        )?.n ?? 0
      );
    },
    /** Marks one read; false when it was already read or doesn't exist. */
    markRead(id: string, at: string): boolean {
      return sql.run("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", at, id).changes > 0;
    },
    markAllRead(at: string): number {
      return Number(sql.run("UPDATE notifications SET read_at = ? WHERE read_at IS NULL", at).changes);
    },
    prune(before: string): void {
      sql.run("DELETE FROM notifications WHERE created_at < ?", before);
    },
  };
}
