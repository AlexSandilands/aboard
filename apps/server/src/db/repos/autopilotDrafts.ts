import { AutomationBundle, type AutomationDraft } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface DraftRow {
  id: string;
  bundle_json: string;
  note: string;
  created_by: string;
  created_at: string;
  expires_at: string;
}

const toDraft = (r: DraftRow): AutomationDraft => ({
  id: r.id,
  // Written through the schema, so it parses; a hand-edited row that doesn't is a corrupt database.
  bundle: AutomationBundle.parse(JSON.parse(r.bundle_json)),
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/** Typed access to autopilot_drafts: automations agents drafted for the user to import. */
export function createAutopilotDraftsRepo(sql: Sql) {
  return {
    get(id: string): AutomationDraft | null {
      const row = sql.get<DraftRow>("SELECT * FROM autopilot_drafts WHERE id = ?", id);
      return row ? toDraft(row) : null;
    },
    /** Newest first. */
    all(): AutomationDraft[] {
      return sql.all<DraftRow>("SELECT * FROM autopilot_drafts ORDER BY created_at DESC, rowid DESC").map(toDraft);
    },
    insert(draft: AutomationDraft): void {
      sql.insert("autopilot_drafts", {
        id: draft.id,
        bundle_json: JSON.stringify(draft.bundle),
        note: draft.note,
        created_by: draft.createdBy,
        created_at: draft.createdAt,
        expires_at: draft.expiresAt,
      });
    },
    delete(id: string): boolean {
      return sql.run("DELETE FROM autopilot_drafts WHERE id = ?", id).changes > 0;
    },
    /** Drops drafts expired at `now`, and all but the newest `keep`. */
    prune(now: string, keep: number): void {
      sql.run("DELETE FROM autopilot_drafts WHERE expires_at <= ?", now);
      sql.run(
        "DELETE FROM autopilot_drafts WHERE id NOT IN (SELECT id FROM autopilot_drafts ORDER BY created_at DESC, rowid DESC LIMIT ?)",
        keep,
      );
    },
  };
}
