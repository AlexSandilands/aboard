import type { Digest, DigestMode, DigestTrigger } from "@repo/contracts";
import type { Sql } from "./sql.ts";

interface DigestRow {
  id: string;
  created_at: string;
  period_from: string;
  period_to: string;
  mode: DigestMode;
  trigger: DigestTrigger;
  body_md: string;
  cost_usd: number | null;
  note: string | null;
  read_at: string | null;
}

const toDigest = (r: DigestRow): Digest => ({
  id: r.id,
  createdAt: r.created_at,
  from: r.period_from,
  to: r.period_to,
  mode: r.mode,
  trigger: r.trigger,
  bodyMd: r.body_md,
  costUsd: r.cost_usd,
  note: r.note,
  readAt: r.read_at,
});

/** Typed access to autopilot_digests, the digest automation's output. */
export function createAutopilotDigestsRepo(sql: Sql) {
  return {
    get(id: string): Digest | null {
      const row = sql.get<DigestRow>("SELECT * FROM autopilot_digests WHERE id = ?", id);
      return row ? toDigest(row) : null;
    },
    /** Newest first (rowid breaks ties within a millisecond). */
    list(limit: number): Digest[] {
      return sql
        .all<DigestRow>("SELECT * FROM autopilot_digests ORDER BY created_at DESC, rowid DESC LIMIT ?", limit)
        .map(toDigest);
    },
    latest(): Digest | null {
      const row = sql.get<DigestRow>("SELECT * FROM autopilot_digests ORDER BY created_at DESC, rowid DESC LIMIT 1");
      return row ? toDigest(row) : null;
    },
    insert(d: Digest): void {
      sql.insert("autopilot_digests", {
        id: d.id,
        created_at: d.createdAt,
        period_from: d.from,
        period_to: d.to,
        mode: d.mode,
        trigger: d.trigger,
        body_md: d.bodyMd,
        cost_usd: d.costUsd,
        note: d.note,
        read_at: d.readAt,
      });
    },
    unread(): number {
      return sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM autopilot_digests WHERE read_at IS NULL")?.n ?? 0;
    },
    /** Marks one read; false when it was already read or doesn't exist. */
    markRead(id: string, at: string): boolean {
      return sql.run("UPDATE autopilot_digests SET read_at = ? WHERE id = ? AND read_at IS NULL", at, id).changes > 0;
    },
    /** Drops all but the newest `keep`. */
    prune(keep: number): void {
      sql.run(
        `DELETE FROM autopilot_digests WHERE id NOT IN (
           SELECT id FROM autopilot_digests ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
        keep,
      );
    },
  };
}
