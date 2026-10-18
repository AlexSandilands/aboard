import type { SocialPostKind } from "@repo/contracts";
import type { Sql } from "./sql.ts";

export interface SocialPostRow {
  id: number;
  handle: string | null;
  kind: SocialPostKind;
  body: string;
  reply_to: number | null;
  task_id: string | null;
  session_id: string | null;
  created_at: string;
}

/** Typed access to social_posts, the agents' social network. */
export function createSocialRepo(sql: Sql) {
  return {
    /** The newest `limit` posts made at or after `since`, oldest first. */
    list(opts: { since: string; limit: number }): SocialPostRow[] {
      return sql
        .all<SocialPostRow>(
          "SELECT * FROM social_posts WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?",
          opts.since,
          opts.limit,
        )
        .reverse();
    },
    get(id: number): SocialPostRow | null {
      return sql.get<SocialPostRow>("SELECT * FROM social_posts WHERE id = ?", id) ?? null;
    },
    insert(post: Omit<SocialPostRow, "id">): number {
      const result = sql.run(
        `INSERT INTO social_posts (handle, kind, body, reply_to, task_id, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        post.handle,
        post.kind,
        post.body,
        post.reply_to,
        post.task_id,
        post.session_id,
        post.created_at,
      );
      return Number(result.lastInsertRowid);
    },
    prune(before: string): void {
      sql.run("DELETE FROM social_posts WHERE created_at < ?", before);
    },
    /** The task an agent session is linked to (its newest link), if any. */
    taskOfSession(sessionId: string): string | null {
      return (
        sql.get<{ task_id: string }>(
          `SELECT task_id FROM task_links WHERE kind = 'agent_session' AND url LIKE ? ESCAPE '\\'
           ORDER BY created_at DESC LIMIT 1`,
          `agent-session://%/${sessionId.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}`,
        )?.task_id ?? null
      );
    },
  };
}
