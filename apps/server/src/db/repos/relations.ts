import { jsonList, type Sql } from "./sql.ts";

/** One "blocker blocks blocked" row. */
export interface RelationRecord {
  blockerId: string;
  blockedId: string;
  createdAt: string;
  actor: string;
}

interface RelationRow {
  blocker_id: string;
  blocked_id: string;
  created_at: string;
  actor: string;
}

const toRecord = (r: RelationRow): RelationRecord => ({
  blockerId: r.blocker_id,
  blockedId: r.blocked_id,
  createdAt: r.created_at,
  actor: r.actor,
});

/** Typed access to task_relations. */
export function createRelationsRepo(sql: Sql) {
  return {
    /** Every relation that has one of `taskIds` on either side. */
    forTasks(taskIds: readonly string[]): RelationRecord[] {
      return sql
        .all<RelationRow>(
          `SELECT * FROM task_relations
           WHERE blocker_id IN (SELECT value FROM json_each(?)) OR blocked_id IN (SELECT value FROM json_each(?))
           ORDER BY created_at, blocker_id, blocked_id`,
          jsonList(taskIds),
          jsonList(taskIds),
        )
        .map(toRecord);
    },
    /** Ids of the tasks on the other side of any relation of `taskIds`. */
    neighbours(taskIds: readonly string[]): string[] {
      const list = jsonList(taskIds);
      return sql
        .all<{ id: string }>(
          `SELECT blocked_id AS id FROM task_relations WHERE blocker_id IN (SELECT value FROM json_each(?))
           UNION SELECT blocker_id FROM task_relations WHERE blocked_id IN (SELECT value FROM json_each(?))`,
          list,
          list,
        )
        .map((r) => r.id);
    },
    /**
     * The chain of blocking from `from` to `to` (each task blocks the next), both ends included, or null when
     * `from` doesn't lead to `to`. A task leads to itself by a chain of one.
     */
    path(from: string, to: string): string[] | null {
      const next = new Map<string, string[]>();
      for (const r of sql.all<RelationRow>("SELECT * FROM task_relations").map(toRecord)) {
        next.set(r.blockerId, [...(next.get(r.blockerId) ?? []), r.blockedId]);
      }
      const via = new Map<string, string>([[from, from]]);
      const queue = [from];
      for (const id of queue) {
        if (id === to) {
          const path = [id];
          while (path[0] !== from) path.unshift(via.get(path[0]!)!);
          return path;
        }
        for (const n of next.get(id) ?? []) {
          if (via.has(n)) continue;
          via.set(n, id);
          queue.push(n);
        }
      }
      return null;
    },
    /** False when the relation already existed. */
    add(blockerId: string, blockedId: string, createdAt: string, actor: string): boolean {
      const result = sql.run(
        "INSERT OR IGNORE INTO task_relations (blocker_id, blocked_id, created_at, actor) VALUES (?, ?, ?, ?)",
        blockerId,
        blockedId,
        createdAt,
        actor,
      );
      return Number(result.changes) > 0;
    },
    /** False when there was no such relation. */
    remove(blockerId: string, blockedId: string): boolean {
      return (
        Number(
          sql.run("DELETE FROM task_relations WHERE blocker_id = ? AND blocked_id = ?", blockerId, blockedId).changes,
        ) > 0
      );
    },
  };
}
