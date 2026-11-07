import type { InboxNotification, NotificationKind } from "@repo/contracts";
import { jsonList, liveTask, type Sql } from "./sql.ts";

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

const RESOLVED_MARK = "#resolved:";

/** Reads and frees the key of every matching row not yet resolved; returns how many of them were unread. */
function resolveWhere(sql: Sql, where: string, args: string[], at: string): number {
  const open = `${where} AND instr(dedupe_key, '${RESOLVED_MARK}') = 0`;
  const unread =
    sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE ${open} AND read_at IS NULL`, ...args)?.n ??
    0;
  sql.run(
    `UPDATE notifications SET read_at = COALESCE(read_at, ?), dedupe_key = dedupe_key || '${RESOLVED_MARK}' || id
     WHERE ${open}`,
    at,
    ...args,
  );
  return unread;
}

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
           WHERE created_at >= ? AND (read_at IS NULL OR read_at >= ?) AND (? IS NULL OR kind = ?) AND ${liveTask("task_id")}
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
           AND ${liveTask("task_id")}
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
          `SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND created_at >= ? AND ${liveTask("task_id")}`,
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
    /** Moves the unread notifications whose dedupe key starts with `prefix` from one task to another. */
    reassignKeyPrefix(prefix: string, from: string, to: string): number {
      return Number(
        sql.run(
          "UPDATE notifications SET task_id = ? WHERE task_id = ? AND read_at IS NULL AND substr(dedupe_key, 1, length(?)) = ?",
          to,
          from,
          prefix,
          prefix,
        ).changes,
      );
    },
    /** Marks the unread notifications whose dedupe key starts with `prefix` read, keeping their keys. */
    markKeyPrefixSeen(prefix: string, at: string): number {
      return Number(
        sql.run(
          "UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND substr(dedupe_key, 1, length(?)) = ?",
          at,
          prefix,
          prefix,
        ).changes,
      );
    },
    /**
     * Marks a task's notifications of one kind resolved: read (if they weren't), and their dedupe key freed (the row
     * keeps a key of its own), so the same state arising again, a re-run that fails again or a reopened round, notifies
     * again, even when the user had already read the first. Returns how many were unread.
     */
    markTaskKindRead(taskId: string, kind: NotificationKind, at: string): number {
      return resolveWhere(sql, "task_id = ? AND kind = ?", [taskId, kind], at);
    },
    /** Like `markTaskKindRead`, for the notifications whose dedupe key starts with `prefix`. */
    markKeyPrefixRead(prefix: string, at: string): number {
      return resolveWhere(sql, "substr(dedupe_key, 1, length(?)) = ?", [prefix, prefix], at);
    },
    prune(before: string): void {
      sql.run("DELETE FROM notifications WHERE created_at < ?", before);
    },
  };
}
