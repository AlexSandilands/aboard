import type { Sql } from "./sql.ts";

/** An automation's auto-pause state in one project (see migration 043). */
export interface AutoPauseRow {
  automation: string;
  projectId: string;
  /** Null once resumed. */
  pausedAt: string | null;
  reason: string | null;
  /** Failures before this don't count towards the next pause; null counts them all. */
  countedFrom: string | null;
}

interface Row {
  automation: string;
  project_id: string;
  paused_at: string | null;
  reason: string | null;
  counted_from: string | null;
}

const toPause = (r: Row): AutoPauseRow => ({
  automation: r.automation,
  projectId: r.project_id,
  pausedAt: r.paused_at,
  reason: r.reason,
  countedFrom: r.counted_from,
});

/** Typed access to autopilot_auto_pauses: automations that paused themselves in a project. */
export function createAutopilotAutoPausesRepo(sql: Sql) {
  return {
    get(automation: string, projectId: string): AutoPauseRow | null {
      const row = sql.get<Row>(
        "SELECT * FROM autopilot_auto_pauses WHERE automation = ? AND project_id = ?",
        automation,
        projectId,
      );
      return row ? toPause(row) : null;
    },
    /** The automations paused now, newest first. */
    paused(): AutoPauseRow[] {
      return sql
        .all<Row>("SELECT * FROM autopilot_auto_pauses WHERE paused_at IS NOT NULL ORDER BY paused_at DESC")
        .map(toPause);
    },
    pause(automation: string, projectId: string, at: string, reason: string): void {
      sql.run(
        `INSERT INTO autopilot_auto_pauses (automation, project_id, paused_at, reason, counted_from) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (automation, project_id) DO UPDATE SET paused_at = excluded.paused_at, reason = excluded.reason`,
        automation,
        projectId,
        at,
        reason,
      );
    },
    /** Lifts the pause, and counts failures again only from `at`. */
    resume(automation: string, projectId: string, at: string): void {
      sql.run(
        `INSERT INTO autopilot_auto_pauses (automation, project_id, paused_at, reason, counted_from) VALUES (?, ?, NULL, NULL, ?)
         ON CONFLICT (automation, project_id) DO UPDATE SET paused_at = NULL, reason = NULL, counted_from = excluded.counted_from`,
        automation,
        projectId,
        at,
      );
    },
  };
}
