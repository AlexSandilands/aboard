import { parseEditableTargetKey, type Suggestion, type SuggestionStatus } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface SuggestionRow {
  id: string;
  target_key: string;
  title: string;
  base_text: string;
  base_hash: string;
  proposed: string;
  rationale: string;
  evidence_json: string;
  status: SuggestionStatus;
  actor: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  outcome: string | null;
}

const toSuggestion = (r: SuggestionRow): Suggestion => ({
  id: r.id,
  targetKey: r.target_key,
  // Written from a parsed target, so it parses; a hand-edited row that doesn't is a corrupt database.
  target: parseEditableTargetKey(r.target_key)!,
  title: r.title,
  baseText: r.base_text,
  baseHash: r.base_hash,
  proposed: r.proposed,
  rationale: r.rationale,
  evidence: JSON.parse(r.evidence_json || "[]") as string[],
  status: r.status,
  actor: r.actor,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  resolvedBy: r.resolved_by,
  outcome: r.outcome,
});

const toRow = (s: Suggestion) => ({
  id: s.id,
  target_key: s.targetKey,
  title: s.title,
  base_text: s.baseText,
  base_hash: s.baseHash,
  proposed: s.proposed,
  rationale: s.rationale,
  evidence_json: JSON.stringify(s.evidence),
  status: s.status,
  actor: s.actor,
  created_at: s.createdAt,
  resolved_at: s.resolvedAt,
  resolved_by: s.resolvedBy,
  outcome: s.outcome,
});

/** Typed access to suggestions: agents' proposed changes to prompts and skills. */
export function createSuggestionsRepo(sql: Sql) {
  return {
    get(id: string): Suggestion | null {
      const row = sql.get<SuggestionRow>("SELECT * FROM suggestions WHERE id = ?", id);
      return row ? toSuggestion(row) : null;
    },
    /** The open suggestion for a target, if any (there is at most one). */
    openFor(targetKey: string): Suggestion | null {
      const row = sql.get<SuggestionRow>(
        "SELECT * FROM suggestions WHERE target_key = ? AND status = 'open'",
        targetKey,
      );
      return row ? toSuggestion(row) : null;
    },
    /** A target's suggestions, newest first, whatever their status. */
    forTarget(targetKey: string, limit: number): Suggestion[] {
      return sql
        .all<SuggestionRow>(
          "SELECT * FROM suggestions WHERE target_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          targetKey,
          limit,
        )
        .map(toSuggestion);
    },
    /** Open ones first (oldest first), then the newest `decidedLimit` decided ones. */
    list(decidedLimit: number): Suggestion[] {
      const open = sql.all<SuggestionRow>("SELECT * FROM suggestions WHERE status = 'open' ORDER BY created_at, rowid");
      const decided = sql.all<SuggestionRow>(
        "SELECT * FROM suggestions WHERE status <> 'open' ORDER BY coalesce(resolved_at, created_at) DESC, rowid DESC LIMIT ?",
        decidedLimit,
      );
      return [...open, ...decided].map(toSuggestion);
    },
    openCount(): number {
      return sql.get<{ n: number }>("SELECT count(*) AS n FROM suggestions WHERE status = 'open'")?.n ?? 0;
    },
    insert(suggestion: Suggestion): void {
      sql.insert("suggestions", toRow(suggestion));
    },
    update(suggestion: Suggestion): void {
      sql.update("suggestions", toRow(suggestion));
    },
  };
}
