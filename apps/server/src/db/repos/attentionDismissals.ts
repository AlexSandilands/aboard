import type { AttentionDismissal } from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

interface DismissalRow {
  task_id: string;
  key: string;
  fingerprint: string;
  actor: string;
  dismissed_at: string;
}

/** Typed access to attention_dismissals: the flags the user dismissed, one row per task and reason key. */
export function createAttentionDismissalsRepo(sql: Sql) {
  return {
    forTasks(taskIds: readonly string[]): Map<string, AttentionDismissal[]> {
      const rows = sql.all<DismissalRow>(
        "SELECT * FROM attention_dismissals WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, key",
        jsonList(taskIds),
      );
      const byTask = new Map<string, AttentionDismissal[]>();
      for (const r of rows) {
        const list = byTask.get(r.task_id) ?? [];
        list.push({ key: r.key, fingerprint: r.fingerprint, actor: r.actor, dismissedAt: r.dismissed_at });
        byTask.set(r.task_id, list);
      }
      return byTask;
    },
    /** Dismisses `key` in the state `fingerprint`, replacing an earlier dismissal of the same key. */
    put(taskId: string, d: AttentionDismissal): void {
      sql.run(
        `INSERT INTO attention_dismissals (task_id, key, fingerprint, actor, dismissed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id, key) DO UPDATE SET
           fingerprint = excluded.fingerprint, actor = excluded.actor, dismissed_at = excluded.dismissed_at`,
        taskId,
        d.key,
        d.fingerprint,
        d.actor,
        d.dismissedAt,
      );
    },
    remove(taskId: string, key: string): void {
      sql.run("DELETE FROM attention_dismissals WHERE task_id = ? AND key = ?", taskId, key);
    },
  };
}
