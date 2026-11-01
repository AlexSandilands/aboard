import type { InboxNotification, NotificationKind } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

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
    /**
     * Newest first (rowid breaks ties within a millisecond). `since` leaves out rows old enough to be pruned;
     * `readSince` leaves out ones read before it (unread ones stay until `since`).
     */
    list(opts: { since: string; readSince: string; kind?: NotificationKind; limit: number }): InboxNotification[] {
      return sql
        .all<NotificationRow>(
          `SELECT * FROM notifications
           WHERE created_at >= ? AND (read_at IS NULL OR read_at >= ?) AND (? IS NULL OR kind = ?)
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          opts.since,
          opts.readSince,
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
    /** Of these kinds, made at or after `from` and before `to`, oldest first. */
    between(kinds: readonly NotificationKind[], from: string, to: string): InboxNotification[] {
      return sql
        .all<NotificationRow>(
          `SELECT * FROM notifications WHERE created_at >= ? AND created_at < ? AND kind IN (SELECT value FROM json_each(?))
           ORDER BY created_at, rowid`,
          from,
          to,
          jsonList(kinds),
        )
        .map(toNotification);
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
    /** Marks a task's unread notifications read; returns how many changed. */
    markTaskRead(taskId: string, at: string): number {
      return Number(
        sql.run("UPDATE notifications SET read_at = ? WHERE task_id = ? AND read_at IS NULL", at, taskId).changes,
      );
    },
    /** Marks a task's unread notifications of one kind read; returns how many changed. */
    markTaskKindRead(taskId: string, kind: NotificationKind, at: string): number {
      return Number(
        sql.run(
          "UPDATE notifications SET read_at = ? WHERE task_id = ? AND kind = ? AND read_at IS NULL",
          at,
          taskId,
          kind,
        ).changes,
      );
    },
    /** Marks the unread notifications whose dedupe key starts with `prefix` read; returns how many changed. */
    markKeyPrefixRead(prefix: string, at: string): number {
      return Number(
        sql.run(
          "UPDATE notifications SET read_at = ? WHERE substr(dedupe_key, 1, length(?)) = ? AND read_at IS NULL",
          at,
          prefix,
          prefix,
        ).changes,
      );
    },
    prune(before: string): void {
      sql.run("DELETE FROM notifications WHERE created_at < ?", before);
    },
  };
}
